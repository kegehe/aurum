import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IJobScheduler, JobHandler } from './interfaces/job-scheduler.interface';
import { ProcessingJobRepository } from './repositories/processing-job.repository';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { JobStatus, JobType, ProcessingStatus } from '../../common/constants/enums';
import { resolveResourceProcessingStatus } from './resource-status.util';

/** 回收扫描每页条数：避免积压时把整表读进内存 */
const STALE_SWEEP_PAGE_SIZE = 200;
/** 退出前等待在跑任务自然结束的宽限时间 */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * 轮询式任务调度器
 *
 * 在 NestJS 进程内通过 setInterval 轮询 processing_jobs 表，
 * 认领 pending 任务并分发到注册的 Processor。
 *
 * 设计要点：
 * - 并发控制：activeJobCount < concurrency 时才认领新任务
 * - 即时补位：任务结束释放并发槽后立刻再轮询一轮，不等下一次定时器；
 *   否则两个 0.1s 的缩略图任务会让进程空转近 5s，大批量导入要排队几十分钟
 * - 重试机制：失败任务 retryCount < maxRetry 时重置为 pending，超限标记 failed
 * - 心跳续租：执行中的任务定期刷新 updatedAt，证明自己还活着
 * - 启动 + 定期回收：扫描超过 staleTimeoutMs 没有心跳、或单次执行超过 maxExecutionMs
 *   的 processing 任务，重新排队或标记失败。用心跳而不是单纯 startedAt 判断日常卡死，
 *   避免误伤其它进程正在执行的长任务；maxExecutionMs 兜底处理器 Promise 永久挂起
 *   （此时进程仍活着、心跳照常）的极端情况
 * - 幂等入队：同资源同类型已有 pending/processing 任务则跳过
 * - 优雅退出：先给在跑任务一个短暂收敛窗口，仍未完成的把租约放回 pending，
 *   避免进程重启后这些任务要等满 staleTimeoutMs 才被回收
 *
 * 未来切换 Redis+BullMQ：实现 BullMQJobScheduler implements IJobScheduler，
 * 在 ProcessingModule 改 useClass 即可。
 */
@Injectable()
export class PollingJobScheduler
  implements IJobScheduler, OnApplicationBootstrap, OnApplicationShutdown, OnModuleDestroy
{
  private readonly logger = new Logger(PollingJobScheduler.name);
  private readonly handlers = new Map<string, JobHandler>();
  private pollTimer: NodeJS.Timeout | null = null;
  private staleRecoveryTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;
  private polling = false;
  private recovering = false;
  private activeJobCount = 0;
  /** 本进程正在执行的任务 → 认领信息（续租时校验租约，释放并发槽时防重复扣减） */
  private readonly activeAttempts = new Map<
    string,
    { startedAt: Date | null; released: boolean; resourceId: string }
  >();
  /** 本进程尚未结束的执行 Promise（退出前用它判断是否还需要宽限） */
  private readonly inflight = new Set<Promise<void>>();
  /** 资源 → 串行执行的状态重算队列（防止同资源的两个任务同时结束时丢失更新） */
  private readonly statusRefreshChains = new Map<string, Promise<void>>();
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly maxRetry: number;
  private readonly processingEnabled: boolean;
  /** processing 超过该时长没有心跳视为卡死 */
  private readonly staleTimeoutMs: number;
  /** 单次执行时长上限：兜底处理器 Promise 挂起但进程仍能心跳的情况 */
  private readonly maxExecutionMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly jobRepo: ProcessingJobRepository,
    private readonly resourceRepo: ResourceRepository,
    config: ConfigService,
  ) {
    this.pollIntervalMs = config.get<number>('worker.pollIntervalMs')!;
    this.concurrency = config.get<number>('worker.concurrency')!;
    this.maxRetry = config.get<number>('worker.maxRetry')!;
    this.staleTimeoutMs = config.get<number>('worker.staleTimeoutMs') ?? 5 * 60 * 1000;
    this.maxExecutionMs = config.get<number>('worker.maxExecutionMs') ?? 30 * 60 * 1000;
    this.heartbeatIntervalMs = Math.max(
      5_000,
      Math.min(Math.floor(this.staleTimeoutMs / 4), 30_000),
    );
    this.processingEnabled = config.get<boolean>('execution.processingEnabled') ?? true;
  }

  /**
   * 用 onApplicationBootstrap 而不是 onModuleInit：后者会与 ProcessorRegistry
   * 的 onModuleInit 并发执行，极端情况下首个任务会在 handler 注册前被认领，
   * 被误判为「无处理器」永久失败。Bootstrap 钩子保证所有模块初始化完成后才启动轮询。
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.processingEnabled) {
      // 独立 Worker 模式下本进程只入队，不认领任务（stale 恢复也由 Worker 负责）
      this.logger.log('处理任务执行已关闭（EXECUTION_ENABLED=false），本进程只入队');
      return;
    }
    // 先启动轮询，再异步回收上次进程遗留、且已停止心跳的任务：
    // 任务表积压时回收要跑很多轮，不能让进程启动跟着一起等。
    // 靠心跳区分「已死」与「其它进程正在跑」，回收失败也不影响轮询继续重试。
    this.start();
    void this.resetStaleProcessingJobs();
  }

  /**
   * 退出时收敛在跑任务
   *
   * 进程停掉后这些任务本来要等满 staleTimeoutMs 才会被别的进程回收；
   * 这里先等一小段时间让短任务自然结束，剩下的把租约放回 pending。
   *
   * 注意：Nest 的 onModuleDestroy（PrismaService 在这里 $disconnect）先于本钩子执行，
   * Prisma 客户端会在下一次查询时自动重连，所以这里的回写仍然有效；万一失败，
   * 异常只记日志，任务仍由租约到期后的回收兜住。
   */
  async onApplicationShutdown(): Promise<void> {
    this.stop();
    await this.drainAndRequeueActiveJobs();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  // ==================== IJobScheduler 实现 ====================

  async enqueue(jobType: JobType, resourceId: string): Promise<void> {
    // 幂等：已有同资源同类型 pending/processing 任务则跳过
    const existing = await this.jobRepo.findByResourceId(resourceId);
    const conflict = existing.find(
      (j) =>
        j.jobType === jobType &&
        (j.status === JobStatus.pending || j.status === JobStatus.processing),
    );
    if (conflict) {
      // 卡死的 processing 任务会让「重新处理」永远被去重跳过：
      // 就地回收它，让本次操作真正生效，而不是等定期巡回到来。
      if (conflict.status === JobStatus.processing && this.isStale(conflict)) {
        if (conflict.retryCount < this.maxRetry) {
          const requeued = await this.jobRepo.retryIfProcessing(conflict.id, conflict.startedAt);
          if (requeued) {
            await this.refreshResourceStatus(resourceId);
            this.logger.warn(
              `Requeued stale job ${conflict.id} (${jobType}) on enqueue for resource ${resourceId}`,
            );
            return;
          }
          // 回收失败说明状态在读取后被并发改变，走下面的复查
        } else {
          // 超限任务标记失败后继续创建新任务，给用户重新处理的完整重试预算；
          // 失败说明状态被并发改变，同样走复查
          await this.jobRepo.failIfProcessing(
            conflict.id,
            'Max retries exceeded (stale job on re-enqueue)',
            conflict.startedAt,
          );
        }

        // 复查：只有确实没有活跃任务时才新建，避免同一资源出现重复任务
        const latest = await this.jobRepo.findByResourceId(resourceId);
        const stillActive = latest.some(
          (j) =>
            j.jobType === jobType &&
            (j.status === JobStatus.pending || j.status === JobStatus.processing),
        );
        if (stillActive) {
          this.logger.debug(
            `Job ${jobType} for resource ${resourceId} became active, skip enqueue`,
          );
          return;
        }
      } else {
        this.logger.debug(`Skipping duplicate job ${jobType} for resource ${resourceId}`);
        return;
      }
    }

    // 创建新任务：幂等检查与插入放在同一个事务里，
    // 避免上面的读取之后、插入之前另一个进程抢先插了一条活跃任务。
    const created = await this.jobRepo.createIfNoActive(jobType, resourceId);
    if (!created) {
      this.logger.debug(`Job ${jobType} for resource ${resourceId} became active, skip enqueue`);
      return;
    }

    // 重算资源处理状态（而不是无条件写 pending）：
    // 同资源可能还有别的任务正在另一个消费者里执行，不能被降级成 pending。
    await this.refreshResourceStatus(resourceId);

    this.logger.log(`Enqueued job ${jobType} for resource ${resourceId}`);
  }

  onJobType(jobType: JobType, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  start(): void {
    if (!this.processingEnabled || this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    // 心跳：让其它消费者知道本进程的任务仍在执行
    this.heartbeatTimer = setInterval(
      () => void this.heartbeatActiveJobs(),
      this.heartbeatIntervalMs,
    );
    // 定期回收：兜住进程没崩但任务卡死、或上次漏掉的任务
    const recoveryIntervalMs = Math.max(
      this.pollIntervalMs,
      Math.min(this.staleTimeoutMs / 2, 60_000),
    );
    this.staleRecoveryTimer = setInterval(() => void this.recoverExpiredJobs(), recoveryIntervalMs);
    this.logger.log(
      `PollingJobScheduler started (interval=${this.pollIntervalMs}ms, concurrency=${this.concurrency}, maxRetry=${this.maxRetry}, staleTimeout=${this.staleTimeoutMs}ms, maxExecution=${this.maxExecutionMs}ms, heartbeat=${this.heartbeatIntervalMs}ms)`,
    );
    // 立即执行首次轮询
    void this.poll();
  }

  stop(): void {
    const wasRunning = this.running;
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.staleRecoveryTimer) {
      clearInterval(this.staleRecoveryTimer);
      this.staleRecoveryTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (wasRunning) this.logger.log('PollingJobScheduler stopped');
  }

  // ==================== 内部实现 ====================

  private async poll(): Promise<void> {
    // 防止上一轮轮询还没结束（DB 慢）时定时器再次进入，导致突破 concurrency 上限
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      // 停止后不再继续认领：退出流程里正在跑的这一轮轮询不能又抓一个新任务
      while (this.running && this.activeJobCount < this.concurrency) {
        const claimed = await this.claimAndExecute();
        if (!claimed) break;
      }
    } catch (err) {
      this.logger.error(`Poll cycle error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /**
   * 认领并执行一个任务
   * @returns true 表示认领并开始执行了一个任务，false 表示无待处理任务
   */
  private async claimAndExecute(): Promise<boolean> {
    const job = await this.jobRepo.claimNext();
    if (!job) return false;

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      this.logger.warn(`No handler registered for job type: ${job.jobType}, marking as failed`);
      await this.jobRepo.failIfProcessing(
        job.id,
        `No handler for job type: ${job.jobType}`,
        job.startedAt,
      );
      await this.refreshResourceStatus(job.resourceId);
      return true;
    }

    // 任务已认领，设置资源状态为 processing（失败不影响执行，后续完成后会重算）
    try {
      await this.resourceRepo.updateProcessingStatus(job.resourceId, ProcessingStatus.processing);
    } catch (err) {
      this.logger.warn(
        `Failed to mark resource ${job.resourceId} as processing: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 同一任务可能被回收后在本进程重新认领：先释放旧执行的槽位，否则会永久漏掉一个并发名额
    const previous = this.activeAttempts.get(job.id);
    if (previous) {
      if (!previous.released) this.activeJobCount--;
      this.activeAttempts.delete(job.id);
    }
    this.activeJobCount++;
    this.activeAttempts.set(job.id, {
      startedAt: job.startedAt,
      released: false,
      resourceId: job.resourceId,
    });

    // 异步执行，不阻塞轮询；兜住 executeJob 内部 DB 异常，避免未处理的 rejection 退出进程
    const done = this.executeJob(job, handler).catch((err) => {
      this.logger.error(
        `Job ${job.id} (${job.jobType}) bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // 退出时据此判断是否还有任务在跑（含被回收后重新认领、旧执行仍未返回的情况）
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));
    return true;
  }

  private async executeJob(
    job: {
      id: string;
      resourceId: string;
      jobType: string;
      retryCount: number;
      startedAt: Date | null;
    },
    handler: JobHandler,
  ): Promise<void> {
    try {
      try {
        await handler({
          id: job.id,
          resourceId: job.resourceId,
          jobType: job.jobType,
          retryCount: job.retryCount,
        });
      } catch (err) {
        // 只把「处理器失败」当任务失败；后续状态更新失败不能被误判成任务失败
        await this.handleJobFailure(job, err);
        return;
      }

      // 条件更新：任务可能已被用户取消 / 被 stale 回收后重新认领，
      // 此时旧执行结果不能覆盖新状态。
      const updated = await this.jobRepo.completeIfProcessing(job.id, job.startedAt);
      if (!updated) {
        this.logger.warn(
          `Job ${job.id} (${job.jobType}) finished but is no longer the active attempt; status left unchanged`,
        );
        return;
      }
      this.logger.log(`Job ${job.id} (${job.jobType}) completed for resource ${job.resourceId}`);
    } finally {
      this.releaseAttempt(job.id, job.startedAt);
      // 无论成功、失败、被取消还是租约丢失，都重算一次资源状态。
      // 这能修复「认领时写 processing」与「取消时写 failed」交错的竞态。
      await this.refreshResourceStatus(job.resourceId);
      // 槽位空出来立刻补位：只靠 5s 定时器时，短任务结束后进程会空转到下一个 tick。
      // 放在状态重算之后，避免新认领写入的 processing 被这次重算的旧快照覆盖。
      // poll() 自身有 polling 互斥和并发上限判断，重复调用安全。
      void this.poll();
    }
  }

  /** 处理器的重试/永久失败状态流转 */
  private async handleJobFailure(
    job: {
      id: string;
      resourceId: string;
      jobType: string;
      retryCount: number;
      startedAt: Date | null;
    },
    err: unknown,
  ): Promise<void> {
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.logger.error(`Job ${job.id} (${job.jobType}) failed: ${errorMsg}`);

    if (job.retryCount < this.maxRetry) {
      const updated = await this.jobRepo.retryIfProcessing(job.id, job.startedAt);
      if (!updated) {
        this.logger.warn(
          `Job ${job.id} (${job.jobType}) failed but is no longer the active attempt; not requeued`,
        );
        return;
      }
      this.logger.log(
        `Job ${job.id} will be retried (attempt ${job.retryCount + 1}/${this.maxRetry})`,
      );
      // 资源状态由 executeJob 的 finally 统一重算
      return;
    }

    const updated = await this.jobRepo.failIfProcessing(job.id, errorMsg, job.startedAt);
    if (!updated) {
      this.logger.warn(
        `Job ${job.id} (${job.jobType}) failed but is no longer the active attempt; status left unchanged`,
      );
      return;
    }
    this.logger.warn(`Job ${job.id} failed permanently after ${this.maxRetry} retries`);
  }

  /**
   * 释放一次执行的并发槽（幂等）
   *
   * 心跳发现租约已失效（取消/被回收后重新认领）时会提前释放，
   * 否则挂起的处理器 Promise 会永久占住 concurrency 名额。
   * 处理器最终返回时 finally 再调一次，不会重复扣减。
   */
  private releaseAttempt(jobId: string, startedAt: Date | null): void {
    const attempt = this.activeAttempts.get(jobId);
    if (!attempt || attempt.startedAt !== startedAt) return; // 已被新一次认领替换
    if (!attempt.released) {
      attempt.released = true;
      this.activeJobCount--;
    }
    this.activeAttempts.delete(jobId);
  }

  /**
   * 退出前收敛：给在跑任务一个宽限窗口，仍未完成的把租约放回 pending
   *
   * 走 releaseIfProcessing 而不是 retryIfProcessing：正常退出不是任务失败，
   * 不能消耗重试次数。仍带 startedAt 栅栏，期间被取消/重领的任务不会被改回去。
   */
  private async drainAndRequeueActiveJobs(): Promise<void> {
    if (this.activeAttempts.size === 0 && this.inflight.size === 0) return;
    if (this.inflight.size > 0) {
      this.logger.log(
        `Waiting up to ${SHUTDOWN_GRACE_MS}ms for ${this.inflight.size} running job(s) before requeue`,
      );
    }
    await this.waitForInflight(SHUTDOWN_GRACE_MS);

    const affectedResources = new Set<string>();
    for (const [jobId, attempt] of [...this.activeAttempts]) {
      try {
        if (await this.jobRepo.releaseIfProcessing(jobId, attempt.startedAt)) {
          affectedResources.add(attempt.resourceId);
          this.logger.warn(`Requeued job ${jobId} on shutdown`);
        }
      } catch (err) {
        // 放回失败也没关系：租约到期后会被其它进程回收
        this.logger.warn(
          `Failed to requeue job ${jobId} on shutdown: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        this.releaseAttempt(jobId, attempt.startedAt);
      }
    }

    for (const resourceId of affectedResources) {
      await this.refreshResourceStatus(resourceId);
    }
  }

  /** 等待在跑任务收敛，最多等 graceMs；超时后由调用方处理剩下的 */
  private async waitForInflight(graceMs: number): Promise<void> {
    if (this.inflight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    });
    try {
      await Promise.race([Promise.allSettled([...this.inflight]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 重算并写入资源的 processingStatus
   *
   * 同一资源的重算串成队列：两个任务几乎同时结束时，「读全部任务 → 写状态」
   * 的旧快照可能晚于新快照落库，把刚算出的 completed 又写回 processing，
   * 之后再没有任务事件触发重算，资源就永久卡在「处理中」。
   * 串行化之后，最后执行的一定是最后入队（也就是最后完成）的那次重算。
   */
  private refreshResourceStatus(resourceId: string): Promise<void> {
    const previous = this.statusRefreshChains.get(resourceId) ?? Promise.resolve();
    const next = previous.then(() => this.writeResourceStatus(resourceId));
    this.statusRefreshChains.set(resourceId, next);
    void next.finally(() => {
      if (this.statusRefreshChains.get(resourceId) === next) {
        this.statusRefreshChains.delete(resourceId);
      }
    });
    return next;
  }

  private async writeResourceStatus(resourceId: string): Promise<void> {
    try {
      const allJobs = await this.jobRepo.findByResourceId(resourceId);
      await this.resourceRepo.updateProcessingStatus(
        resourceId,
        resolveResourceProcessingStatus(allJobs),
      );
    } catch (err) {
      // 失败只记录日志：状态更新失败不应让已成功的任务被当成失败重跑
      this.logger.error(
        `Failed to refresh processing status for resource ${resourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 启动时回收上次进程遗留、且已停止心跳的任务
   *
   * 不使用「所有 processing 都重置」：默认启动会同时运行 API 与 Worker 两个消费者，
   * 那样会把另一个进程正在执行的任务也抢过来重复执行。
   * 在 start() 之后异步执行：积压很多时也不阻塞进程启动。
   */
  private async resetStaleProcessingJobs(): Promise<void> {
    try {
      await this.sweepStaleJobs('no heartbeat since previous attempt or execution too long');
    } catch (err) {
      this.logger.error(
        `Startup stale recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 分页扫描并回收卡死任务
   *
   * 每页处理完再取下一页（游标按 id 前进），历史任务再多也不会一次读进内存。
   * 阈值在扫描开始时定死：扫描期间刚被续租的任务不会被误判。
   */
  private async sweepStaleJobs(reason: string): Promise<void> {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const now = Date.now();
      const noHeartbeatBefore = new Date(now - this.staleTimeoutMs);
      const startedBefore = new Date(now - this.maxExecutionMs);
      let afterId: string | undefined;
      for (;;) {
        const page = await this.jobRepo.findStaleProcessing(noHeartbeatBefore, startedBefore, {
          take: STALE_SWEEP_PAGE_SIZE,
          afterId,
        });
        if (page.length === 0) break;
        await this.recoverJobs(page, reason);
        if (page.length < STALE_SWEEP_PAGE_SIZE) break;
        afterId = page[page.length - 1].id;
      }
    } finally {
      this.recovering = false;
    }
  }

  /** 任务是否已卡死：没有心跳，或单次执行超过上限 */
  private isStale(job: { updatedAt: Date; startedAt: Date | null }): boolean {
    const now = Date.now();
    return (
      job.updatedAt.getTime() <= now - this.staleTimeoutMs ||
      (job.startedAt !== null && job.startedAt.getTime() <= now - this.maxExecutionMs)
    );
  }

  /** 给本进程正在执行的任务续租；租约已失效时立刻释放并发槽 */
  private async heartbeatActiveJobs(): Promise<void> {
    if (this.activeAttempts.size === 0) return;
    await Promise.all(
      [...this.activeAttempts].map(async ([id, attempt]) => {
        try {
          const renewed = await this.jobRepo.heartbeat(id, attempt.startedAt);
          if (!renewed) {
            // 任务被取消、或已被回收后重新认领：处理器的 Promise 可能永远不会返回，
            // 不能继续占着并发槽。顺手重算资源状态，避免取消与认领交错后资源卡在 processing。
            this.logger.warn(
              `Job ${id} lost its lease (canceled or re-claimed); releasing concurrency slot`,
            );
            this.releaseAttempt(id, attempt.startedAt);
            await this.refreshResourceStatus(attempt.resourceId);
          }
        } catch (err) {
          // 心跳失败不应影响任务执行；下一轮会重试
          this.logger.warn(
            `Heartbeat failed for job ${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  /** 定期回收：超过 staleTimeoutMs 没有心跳、或单次执行超时的 processing 任务 */
  private async recoverExpiredJobs(): Promise<void> {
    try {
      await this.sweepStaleJobs(
        `no heartbeat for ${Math.round(this.staleTimeoutMs / 1000)}s or execution over ${Math.round(this.maxExecutionMs / 1000)}s`,
      );
    } catch (err) {
      this.logger.error(
        `Stale job recovery error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 恢复一批卡死任务：未超过重试上限的重新排队，超限的标记失败。
   * 每条状态流转都带 startedAt 租约，避免覆盖期间被重新认领的任务。
   */
  private async recoverJobs(
    jobs: Array<{ id: string; resourceId: string; retryCount: number; startedAt: Date | null }>,
    reason: string,
  ): Promise<void> {
    const affectedResources = new Set<string>();
    let requeued = 0;
    let failed = 0;

    for (const job of jobs) {
      if (job.retryCount < this.maxRetry) {
        if (await this.jobRepo.retryIfProcessing(job.id, job.startedAt)) {
          requeued++;
          affectedResources.add(job.resourceId);
          this.logger.warn(`Reset stale job ${job.id} to pending (${reason})`);
        }
      } else if (
        await this.jobRepo.failIfProcessing(
          job.id,
          `Max retries exceeded (${reason})`,
          job.startedAt,
        )
      ) {
        failed++;
        affectedResources.add(job.resourceId);
        this.logger.warn(`Marked stale job ${job.id} as failed after ${this.maxRetry} retries`);
      }
    }

    for (const resourceId of affectedResources) {
      await this.refreshResourceStatus(resourceId);
    }
    if (requeued + failed > 0) {
      this.logger.log(
        `Recovered ${requeued + failed} stale jobs (${requeued} requeued, ${failed} failed)`,
      );
    }
  }
}
