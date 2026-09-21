import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IJobScheduler, JobHandler } from './interfaces/job-scheduler.interface';
import { ProcessingJobRepository } from './repositories/processing-job.repository';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { JobStatus, JobType, ProcessingStatus } from '../../common/constants/enums';

/**
 * 轮询式任务调度器
 *
 * 在 NestJS 进程内通过 setInterval 轮询 processing_jobs 表，
 * 认领 pending 任务并分发到注册的 Processor。
 *
 * 设计要点：
 * - 并发控制：activeJobCount < concurrency 时才认领新任务
 * - 重试机制：失败任务 retryCount < maxRetry 时重置为 pending，超限标记 failed
 * - 启动恢复：onModuleInit 时重置 stuck 在 processing 的旧任务（上次非正常退出遗留）
 * - 幂等入队：同资源同类型已有 pending/processing 任务则跳过
 *
 * 未来切换 Redis+BullMQ：实现 BullMQJobScheduler implements IJobScheduler，
 * 在 ProcessingModule 改 useClass 即可。
 */
@Injectable()
export class PollingJobScheduler implements IJobScheduler, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PollingJobScheduler.name);
  private readonly handlers = new Map<string, JobHandler>();
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private activeJobCount = 0;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly maxRetry: number;

  constructor(
    private readonly jobRepo: ProcessingJobRepository,
    private readonly resourceRepo: ResourceRepository,
    config: ConfigService,
  ) {
    this.pollIntervalMs = config.get<number>('worker.pollIntervalMs')!;
    this.concurrency = config.get<number>('worker.concurrency')!;
    this.maxRetry = config.get<number>('worker.maxRetry')!;
  }

  async onModuleInit(): Promise<void> {
    // 恢复 stuck 任务
    await this.resetStaleProcessingJobs();
    this.start();
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
      this.logger.debug(`Skipping duplicate job ${jobType} for resource ${resourceId}`);
      return;
    }

    // 创建新任务
    await this.jobRepo.create({
      resource: { connect: { id: resourceId } },
      jobType,
      status: JobStatus.pending,
    });

    // 更新资源处理状态为 pending（而非 processing）
    // processing 状态在 job 被 claimNext 时设置
    await this.resourceRepo.updateProcessingStatus(resourceId, ProcessingStatus.pending);

    this.logger.log(`Enqueued job ${jobType} for resource ${resourceId}`);
  }

  onJobType(jobType: JobType, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.logger.log(
      `PollingJobScheduler started (interval=${this.pollIntervalMs}ms, concurrency=${this.concurrency}, maxRetry=${this.maxRetry})`,
    );
    // 立即执行首次轮询
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.log('PollingJobScheduler stopped');
  }

  // ==================== 内部实现 ====================

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      while (this.activeJobCount < this.concurrency) {
        const claimed = await this.claimAndExecute();
        if (!claimed) break;
      }
    } catch (err) {
      this.logger.error(`Poll cycle error: ${err instanceof Error ? err.message : String(err)}`);
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
      await this.jobRepo.updateStatus(
        job.id,
        JobStatus.failed,
        `No handler for job type: ${job.jobType}`,
      );
      await this.resourceRepo.updateProcessingStatus(job.resourceId, ProcessingStatus.failed);
      return true;
    }

    // 任务已认领，设置资源状态为 processing
    await this.resourceRepo.updateProcessingStatus(job.resourceId, ProcessingStatus.processing);

    this.activeJobCount++;

    // 异步执行，不阻塞轮询
    void this.executeJob(job, handler);
    return true;
  }

  private async executeJob(
    job: {
      id: string;
      resourceId: string;
      jobType: string;
      retryCount: number;
    },
    handler: JobHandler,
  ): Promise<void> {
    try {
      await handler({
        id: job.id,
        resourceId: job.resourceId,
        jobType: job.jobType,
        retryCount: job.retryCount,
      });
      await this.jobRepo.updateStatus(job.id, JobStatus.completed);
      this.logger.log(`Job ${job.id} (${job.jobType}) completed for resource ${job.resourceId}`);

      // 检查该资源是否还有未完成的任务，若没有则更新 processingStatus 为 completed
      await this.checkResourceCompletion(job.resourceId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Job ${job.id} (${job.jobType}) failed: ${errorMsg}`);

      if (job.retryCount < this.maxRetry) {
        await this.jobRepo.incrementRetry(job.id);
        this.logger.log(
          `Job ${job.id} will be retried (attempt ${job.retryCount + 1}/${this.maxRetry})`,
        );
      } else {
        await this.jobRepo.updateStatus(job.id, JobStatus.failed, errorMsg);
        // 检查资源状态（可能还有其他待处理任务）
        await this.checkResourceCompletion(job.resourceId);
        this.logger.warn(`Job ${job.id} failed permanently after ${this.maxRetry} retries`);
      }
    } finally {
      this.activeJobCount--;
    }
  }

  /**
   * 检查资源的所有任务是否都已完成
   * 若没有 pending/processing 任务，则更新 processingStatus
   */
  private async checkResourceCompletion(resourceId: string): Promise<void> {
    const allJobs = await this.jobRepo.findByResourceId(resourceId);
    const hasUnfinished = allJobs.some(
      (j) => j.status === JobStatus.pending || j.status === JobStatus.processing,
    );
    if (hasUnfinished) return;

    // 没有未完成任务：检查是否有任一任务成功完成
    const hasCompleted = allJobs.some((j) => j.status === JobStatus.completed);
    const status = hasCompleted ? ProcessingStatus.completed : ProcessingStatus.failed;
    await this.resourceRepo.updateProcessingStatus(resourceId, status);
  }

  /**
   * 重置 stuck 在 processing 状态的旧任务（上次非正常退出遗留）
   */
  private async resetStaleProcessingJobs(): Promise<void> {
    const staleJobs = await this.jobRepo.findMany({ status: 'processing' });
    for (const job of staleJobs.items) {
      if (job.retryCount >= this.maxRetry) {
        await this.jobRepo.updateStatus(
          job.id,
          JobStatus.failed,
          'Max retries exceeded (stale job)',
        );
      } else {
        await this.jobRepo.updateStatus(job.id, JobStatus.pending);
      }
      this.logger.warn(`Reset stale job ${job.id} (was processing)`);
    }
    if (staleJobs.items.length > 0) {
      this.logger.log(`Reset ${staleJobs.items.length} stale jobs`);
    }
  }
}
