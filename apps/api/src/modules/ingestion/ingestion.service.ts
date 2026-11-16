import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { IngestionJob } from '@prisma/client';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  AcquisitionMode,
  FileRole,
  IngestionJobStatus,
  IngestionJobType,
  JobType,
  LocatorType,
  ProcessingStatus,
  ResourceType,
  SourceType,
} from '../../common/constants/enums';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { isUrlWithinSourceBase } from '../../common/security/source-url-policy';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { JOB_SCHEDULER, IJobScheduler } from '../processing/interfaces/job-scheduler.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { ResourceService } from '../resource/resource.service';
import { SourceRepository } from '../source/repositories/source.repository';
import { LinkMetadataConnector } from './connectors/link-metadata.connector';
import { LocatorHealthChecker } from './connectors/locator-health-checker';
import { CivitaiConnector } from './connectors/civitai.connector';
import { GitHubConnector } from './connectors/github.connector';
import { FeedConnector } from './connectors/feed.connector';
import { DirectDownloadConnector } from './connectors/direct-download.connector';
import { ResourceConnector } from './connectors/resource-connector.interface';
import { CreateLinkImportDto } from './dto/create-link-import.dto';
import { QueryIngestionJobsDto } from './dto/query-ingestion-jobs.dto';
import { IngestionJobRepository } from './repositories/ingestion-job.repository';

interface LinkImportRequest {
  url: string;
  sourceId?: string;
  categoryId?: string;
  title?: string;
}

interface SyncSourceRequest {
  sourceId: string;
  cursor?: string | null;
}

interface DownloadResourceRequest {
  resourceId: string;
}

interface CapturePageRequest {
  resourceId: string;
  url: string;
}

interface DownloadJobControl {
  id: string;
  leaseToken: string;
  completeOnCommit?: boolean;
}

/** 批量镜像时单个资源被跳过的原因，供前端分类提示 */
export type MirrorSkipReason =
  'not_found' | 'deleted' | 'already_local' | 'no_source_url' | 'no_source' | 'policy' | 'error';

export interface MirrorSkipDetail {
  id: string;
  reason: MirrorSkipReason;
  message: string;
}

/**
 * 单资源预检失败：仍然按 400 返回给单资源接口（行为不变），
 * 批量接口据此区分「已有本地文件 / 无下载地址 / 已删除」等跳过原因。
 */
class MirrorSkipException extends BadRequestException {
  constructor(
    readonly skipReason: Extract<
      MirrorSkipReason,
      'deleted' | 'already_local' | 'no_source_url' | 'no_source'
    >,
    message: string,
  ) {
    super(message);
  }
}

/** 来源同步时并发下载的文件数 */
const SYNC_DOWNLOAD_CONCURRENCY = 4;
/** 同步下载并发的上限（防止来源 maxConcurrency 误配导致打爆远程服务） */
const SYNC_DOWNLOAD_CONCURRENCY_CAP = 20;
/** 单次来源同步最多连续抓取的页数（上限，防止误配导致大量下载） */
const SYNC_MAX_PAGES_CAP = 50;
/** 单个远端文件的整体下载超时（DirectDownloadConnector 内部另有读写超时） */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 180_000;
/**
 * 下载任务心跳间隔上限。stale 恢复默认按 60s 判断（INGESTION_STALE_JOB_TIMEOUT_MS），
 * 下载本身允许 180s，因此必须周期性刷新 startedAt，否则长下载会被中途重置。
 * 实际间隔会按配置的 stale 超时 / 3 收缩（见 downloadRemoteFile）。
 */
const JOB_HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * 手动下载任务因限速被延后后，给该来源保留的优先窗口（在槽位时间之上额外留出）。
 * 同步下载的等待循环会在这段时间内让出槽位，避免手动任务被同步的并发等待者饿死。
 */
const MANUAL_DOWNLOAD_PRIORITY_GRACE_MS = 10_000;
/** 同步内瞬时网络错误的重试间隔（不含首次尝试） */
const INLINE_DOWNLOAD_RETRY_DELAYS_MS = [1_000, 3_000];
/** 下载失败自动补漏的尝试上限（达到后不再自动重试，需手动触发） */
const DOWNLOAD_RETRY_MAX_ATTEMPTS = 5;
/** 补漏重试的指数退避基数与上限 */
const DOWNLOAD_RETRY_BASE_MS = 30 * 60_000;
const DOWNLOAD_RETRY_MAX_DELAY_MS = 24 * 60 * 60_000;
/** 补漏只处理创建超过该时长的资源，避免与正在进行的同步抢同一条目 */
const RETRY_SWEEP_MIN_AGE_MS = 10 * 60_000;
/**
 * 单次批量镜像最多接受的资源数。
 * 服务端逐条走策略门禁与入队（每条多次数据库往返），限流避免单个请求
 * 长时间占用连接；前端会按更小的分片自动提交，正常使用不会触及该上限。
 */
export const MAX_BATCH_MIRROR_RESOURCES = 500;
/**
 * 远端条目台账中表示「原文件已成功下载过」的状态。
 * 另一个状态 metadata_only 表示只记录过元数据，不阻止后续下载。
 */
const SYNC_LEDGER_DOWNLOADED = 'downloaded';
/**
 * 页面快照的响应体上限。现代新闻/社区站点的骨架 HTML 常在 0.5–2 MB，
 * 上限太小会让快照对真实页面失效；再大则说明抓到的不是页面本身。
 */
const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

class SyncJobCanceledError extends Error {}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  /**
   * 后台来源同步的单飞标志：一次只允许一个 sync_source 任务在执行。
   * 同步会并发下载大量文件，若多个同步同时跑，SQLite 写锁竞争与下载并发叠加
   * 都可能导致问题。任务已认领（processing + lease），由 touchJob 心跳保活。
   */
  private syncJobRunning = false;
  /**
   * 按来源的下载速率槽。自动同步与手动/批量镜像共用同一份预算，
   * 避免两条链路各自按 rateLimitPerMinute 放行、叠加后超过来源限制。
   *
   * 自动同步在下载前阻塞等待槽位；手动下载任务走同一条摄入队列，
   * 阻塞等待会卡住 import_url / check_locator 等其它任务，因此拿不到槽位时
   * 把任务释放回 pending 并设置 nextRunAt。
   */
  private readonly sourceDownloadSlots = new Map<
    string,
    { intervalMs: number; nextAvailableAt: number }
  >();
  /**
   * 手动下载任务被限速延后时，记录该来源的优先截止时间。
   * 同步等待循环在此期间让出槽位，让调度器重新认领的手动任务先下载。
   */
  private readonly manualDownloadPriorityUntil = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobRepo: IngestionJobRepository,
    private readonly sourceRepo: SourceRepository,
    private readonly resourceRepo: ResourceRepository,
    private readonly safeUrl: SafeUrlService,
    private readonly linkMetadataConnector: LinkMetadataConnector,
    private readonly locatorHealthChecker: LocatorHealthChecker,
    private readonly civitaiConnector: CivitaiConnector,
    private readonly githubConnector: GitHubConnector,
    private readonly feedConnector: FeedConnector,
    private readonly directDownload: DirectDownloadConnector,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    private readonly fileRepo: ResourceFileRepository,
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly config: ConfigService,
    private readonly resourceService: ResourceService,
  ) {}

  async createLinkImport(dto: CreateLinkImportDto) {
    const normalizedUrl = this.safeUrl.normalize(dto.url).toString();
    if (dto.sourceId) await this.assertLinkImportAllowed(dto.sourceId, normalizedUrl);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);

    const request: LinkImportRequest = {
      url: normalizedUrl,
      sourceId: dto.sourceId,
      categoryId: dto.categoryId,
      title: dto.title?.trim() || undefined,
    };
    const idempotencyKey = createHash('sha256')
      .update(`${IngestionJobType.import_url}:${JSON.stringify(request)}`)
      .digest('hex');
    const existing = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    try {
      return await this.jobRepo.create({
        sourceId: dto.sourceId,
        jobType: IngestionJobType.import_url,
        request: JSON.stringify(request),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const activeJob = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
        if (activeJob) return activeJob;
      }
      throw error;
    }
  }

  async listJobs(query: QueryIngestionJobsDto) {
    const result = await this.jobRepo.findMany(query);
    return { ...result, totalPages: Math.ceil(result.total / result.pageSize) };
  }

  async getJob(id: string) {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`Ingestion job ${id} not found`);
    return job;
  }

  /** 摄入任务统计（按状态分组），供导入任务中心展示 */
  async getStats(): Promise<Record<string, number>> {
    return this.jobRepo.stats();
  }

  async retryJob(id: string) {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`Ingestion job ${id} not found`);
    if (job.status !== IngestionJobStatus.failed && job.status !== IngestionJobStatus.canceled) {
      throw new BadRequestException(`Cannot retry an ${job.status} ingestion job`);
    }
    const activeJob = await this.jobRepo.findActiveByIdempotencyKey(job.idempotencyKey);
    if (activeJob && activeJob.id !== job.id) return activeJob;
    try {
      const retried = await this.jobRepo.retryIfRetryable(id);
      if (retried) return retried;
      const concurrentJob = await this.jobRepo.findActiveByIdempotencyKey(job.idempotencyKey);
      if (concurrentJob) return concurrentJob;
      throw new BadRequestException(`Cannot retry an ingestion job that is no longer terminal`);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrentJob = await this.jobRepo.findActiveByIdempotencyKey(job.idempotencyKey);
        if (concurrentJob) return concurrentJob;
      }
      throw error;
    }
  }

  async cancelJob(id: string) {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`Ingestion job ${id} not found`);
    if (job.status !== IngestionJobStatus.pending && job.status !== IngestionJobStatus.processing) {
      throw new BadRequestException(`Cannot cancel an ${job.status} ingestion job`);
    }
    if (!(await this.jobRepo.cancel(id))) {
      throw new BadRequestException('Ingestion job is no longer active');
    }
    return this.getJob(id);
  }

  /** 删除指定已结束（terminal）的任务记录；活跃任务需先取消 */
  async deleteJob(id: string) {
    const job = await this.jobRepo.findById(id);
    if (!job) throw new NotFoundException(`Ingestion job ${id} not found`);
    if (job.status === IngestionJobStatus.pending || job.status === IngestionJobStatus.processing) {
      throw new BadRequestException('Cannot delete an active ingestion job');
    }
    if (!(await this.jobRepo.deleteTerminal(id))) {
      throw new BadRequestException('Ingestion job is no longer terminal');
    }
    return { id, deleted: true };
  }

  /** 清空所有已结束（terminal）的任务记录 */
  async clearJobs() {
    const deleted = await this.jobRepo.clearTerminal();
    return { deleted };
  }

  /**
   * 清除远端条目台账（同步记录）。
   *
   * 台账默认阻止「已下载过的条目」再次下载，即使对应资源已被彻底删除。
   * 用户想重新下载这些条目时调用本方法：删除后下次同步会重新抓取并下载。
   * 传 sourceId 只清该来源的记录，并重置该来源的翻页游标（否则翻过的页不会再被抓到）；
   * 不传则清空全部台账，但不改动任何来源的游标。
   */
  async clearSyncHistory(sourceId?: string) {
    const result = await this.prisma.sourceItemLedger.deleteMany({
      where: sourceId ? { sourceId } : {},
    });
    // 只清台账不够：游标还停在旧位置时，那些条目根本不会再被翻到。
    // 因此按来源清理时一并清空游标，让下次同步从头翻页（已下载的条目仍被台账跳过）。
    const cursorReset = sourceId ? await this.resetSourceCursor(sourceId) : false;
    return { deleted: result.count, cursorReset };
  }

  /** 清空来源 config 里的翻页游标；返回是否真的改动了配置 */
  private async resetSourceCursor(sourceId: string): Promise<boolean> {
    const source = await this.sourceRepo.findById(sourceId).catch(() => null);
    if (!source?.config) return false;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(source.config) as Record<string, unknown>;
    } catch {
      // 配置损坏时不擅自覆盖，交给用户重新编辑来源
      return false;
    }
    if (!('cursor' in config)) return false;
    delete config.cursor;
    await this.sourceRepo.update(sourceId, { config: JSON.stringify(config) });
    return true;
  }

  async runNextJob(): Promise<boolean> {
    const job = await this.jobRepo.claimNext();
    if (!job) return false;
    if (!job.leaseToken) {
      this.logger.error(`Claimed ingestion job ${job.id} without a lease token`);
      return true;
    }
    const leaseToken = job.leaseToken;
    try {
      if (
        job.jobType !== IngestionJobType.import_url &&
        job.jobType !== IngestionJobType.check_locator &&
        job.jobType !== IngestionJobType.sync_source &&
        job.jobType !== IngestionJobType.download_file &&
        job.jobType !== IngestionJobType.capture_page
      ) {
        throw new BadRequestException(`Unsupported ingestion job type: ${job.jobType}`);
      }
      if (job.jobType === IngestionJobType.sync_source) {
        // 来源同步可能耗时较长（下载大量文件），在后台执行，避免阻塞摄入队列
        // （poll 单飞，等待同步会把 import_url / check_locator 全部卡住）。
        if (this.syncJobRunning) {
          // 已有同步在跑：把本次认领的任务释放回 pending，下轮轮询再认领。
          // 不做并发同步，避免 SQLite 写锁竞争与下载并发叠加。
          // 释放时加退避（≥2 个轮询周期），避免该任务每次轮询都被重新认领、
          // 把排在它后面的 import_url / check_locator 任务饿死。
          const backoffMs = Math.max(this.pollIntervalMs() * 2, 5000);
          try {
            await this.jobRepo.release(job.id, leaseToken, backoffMs);
            this.logger.debug(
              `Sync job ${job.id} deferred for ${backoffMs}ms (another sync is running)`,
            );
          } catch (error) {
            // 释放失败不能把任务标记为终态失败：保持 processing，
            // 交给 stale 恢复重新排队即可自动重试。
            this.logger.warn(
              `Failed to defer sync job ${job.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          return true;
        }
        this.syncJobRunning = true;
        void this.executeSyncJob(job, leaseToken)
          .catch((error) => {
            // executeSyncJob 内部已捕获业务失败并标记任务失败；这里兜底防御
            // failIngestionJob 本身抛错（如 DB 不可用）导致的未处理 rejection。
            this.logger.error(
              `Unexpected error in background sync job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            this.syncJobRunning = false;
          });
        return true;
      }
      if (job.jobType === IngestionJobType.check_locator) {
        await this.runLocatorCheck(job, leaseToken);
        return true;
      }
      if (job.jobType === IngestionJobType.download_file) {
        await this.runDownloadResourceJob(job, leaseToken);
        return true;
      }
      if (job.jobType === IngestionJobType.capture_page) {
        await this.runCapturePageJob(job, leaseToken);
        return true;
      }
      const request = this.parseLinkImportRequest(job.request);
      if (request.sourceId) await this.assertLinkImportAllowed(request.sourceId, request.url);
      const metadata = await this.linkMetadataConnector.inspect(request.url, {
        validateUrl: request.sourceId
          ? async (candidate) => this.assertLinkImportAllowed(request.sourceId!, candidate)
          : undefined,
      });
      if (request.sourceId) await this.assertLinkImportAllowed(request.sourceId, metadata.finalUrl);
      const existing = await this.resourceRepo.findByIdentityUrl(metadata.finalUrl);
      const resourceId = existing
        ? await this.reuseLinkResource(existing.resourceId, existing.resource.deletedAt, request)
        : await this.createOrReuseLinkResource(request, metadata, job.id);
      const completed = await this.jobRepo.complete(
        job.id,
        leaseToken,
        resourceId,
        JSON.stringify({ canonicalUrl: metadata.canonicalUrl }),
      );
      if (completed)
        this.logger.log(`Imported link resource ${resourceId} from ${metadata.canonicalUrl}`);
      else this.logger.warn(`Ingestion job ${job.id} lost its lease before completion`);
    } catch (error) {
      await this.failIngestionJob(job.id, leaseToken, error);
    }
    return true;
  }

  /**
   * 后台执行同步任务。任务已在 runNextJob 中认领（processing + lease），
   * runSyncSourceJob 内部用 touchJob 心跳防止被 stale 恢复重置。
   */
  private async executeSyncJob(job: IngestionJob, leaseToken: string): Promise<void> {
    try {
      await this.runSyncSourceJob(job, leaseToken);
    } catch (error) {
      await this.failIngestionJob(job.id, leaseToken, error);
    }
  }

  /** 标记摄入任务失败（共享失败处理：错误码分类 + lease 校验 + 日志） */
  private async failIngestionJob(jobId: string, leaseToken: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof BadRequestException ? 'invalid_remote_resource' : 'import_failed';
    const failed = await this.jobRepo.fail(jobId, leaseToken, errorCode, message);
    if (failed) this.logger.warn(`Ingestion job ${jobId} failed: ${message}`);
    else this.logger.warn(`Ingestion job ${jobId} lost its lease before failure: ${message}`);
  }

  async resetStaleJobs(staleJobTimeoutMs: number) {
    return this.jobRepo.resetStaleProcessing(new Date(Date.now() - staleJobTimeoutMs));
  }

  /**
   * 调度过期 locator 的健康检查任务
   *
   * 退避策略（基于上次检查结果，不含连续失败次数，因 ResourceLocator 无此字段）：
   * - 从未检查 → 立即
   * - 上次失败 (httpStatus 4xx+ 或 lastError 非空) → 1 天后重查
   * - 上次成功 → 7 天后重查
   */
  async scheduleLocatorHealthChecks(batchSize = 10): Promise<number> {
    const MS_DAY = 24 * 60 * 60 * 1000;
    const isFailure = (l: { httpStatus: number | null; lastError: string | null }) =>
      (l.httpStatus ?? 0) >= 400 || l.lastError !== null;
    const isNeverChecked = (l: { lastCheckedAt: Date | null }) => l.lastCheckedAt === null;

    // 按优先级从高到低查询
    const tiers: Array<{
      staleBefore: Date;
      filter: (l: {
        httpStatus: number | null;
        lastError: string | null;
        lastCheckedAt: Date | null;
      }) => boolean;
    }> = [
      // 从未检查 → 立即；失败 → 1 天
      {
        staleBefore: new Date(Date.now() - 1 * MS_DAY),
        filter: (l) => isNeverChecked(l) || isFailure(l),
      },
      // 成功 → 7 天
      { staleBefore: new Date(Date.now() - 7 * MS_DAY), filter: () => true },
    ];

    let created = 0;
    for (const tier of tiers) {
      if (created >= batchSize) break;
      const remaining = batchSize - created;
      const locators = await this.jobRepo.findLocatorsNeedingCheck(tier.staleBefore, remaining);
      for (const locator of locators) {
        if (!tier.filter(locator)) continue;
        const job = await this.enqueueLocatorCheck(
          locator.id,
          locator.url,
          locator.sourceId ?? undefined,
        );
        if (job) created++;
        if (created >= batchSize) break;
      }
    }
    return created;
  }

  /** 为单个 locator 创建 check_locator 任务（幂等） */
  async enqueueLocatorCheck(locatorId: string, url: string, sourceId?: string) {
    const idempotencyKey = `check_locator:${locatorId}`;
    const existing = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    try {
      return await this.jobRepo.create({
        sourceId,
        jobType: IngestionJobType.check_locator,
        request: JSON.stringify({ locatorId, url }),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const activeJob = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
        if (activeJob) return activeJob;
      }
      throw error;
    }
  }

  /**
   * 手动触发资源所有定位器的健康检查
   * 为每个 locator 创建 check_locator 任务
   */
  async checkResourceLocators(resourceId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: { locators: true },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    if (resource.locators.length === 0) {
      return { jobs: [], message: 'No locators to check' };
    }
    const jobs = [];
    for (const locator of resource.locators) {
      // 手动触发时使用带时间戳的 idempotencyKey 以绕过幂等检查
      const idempotencyKey = `check_locator:${locator.id}:${Date.now()}`;
      const job = await this.jobRepo.create({
        sourceId: locator.sourceId ?? undefined,
        jobType: IngestionJobType.check_locator,
        request: JSON.stringify({ locatorId: locator.id, url: locator.url }),
        idempotencyKey,
      });
      jobs.push(job);
    }
    return { jobs, message: `Created ${jobs.length} health check jobs` };
  }

  /**
   * 策略门禁：检查是否允许创建 mirror_file/archive_snapshot 任务
   *
   * - 来源必须存在且启用
   * - 来源必须允许该导入模式
   * - 来源不得需要人工审核
   */
  async assertDownloadAllowed(
    sourceId: string | null | undefined,
    acquisitionMode: string,
    manuallyReviewed = false,
  ): Promise<void> {
    if (
      acquisitionMode !== AcquisitionMode.mirror_file &&
      acquisitionMode !== AcquisitionMode.archive_snapshot
    ) {
      return; // link_only 和 metadata_only 不需要门禁
    }
    if (!sourceId) {
      throw new BadRequestException('Download requires a source configuration');
    }
    const source = await this.sourceRepo.findById(sourceId);
    if (!source) throw new NotFoundException(`Source ${sourceId} not found`);
    if (!source.enabled) throw new BadRequestException('Source is disabled');
    const allowedModes = source.allowedModes.split(',').map((m) => m.trim());
    // Older metadata-only sources were persisted before mirror_file was added
    // to their policy. A user-triggered mirror is the required explicit review
    // and remains compatible with those existing source records.
    const isLegacyReviewedMirror =
      manuallyReviewed &&
      acquisitionMode === AcquisitionMode.mirror_file &&
      source.requiresReview &&
      allowedModes.includes(AcquisitionMode.metadata_only);
    if (!allowedModes.includes(acquisitionMode) && !isLegacyReviewedMirror) {
      throw new BadRequestException(`Source does not allow ${acquisitionMode} mode`);
    }
    if (source.requiresReview && !manuallyReviewed) {
      throw new BadRequestException('Source requires manual review before download');
    }
  }

  /**
   * Queue a user-approved mirror download for a metadata-only remote resource.
   * The source still has to explicitly permit mirror_file downloads.
   */
  async mirrorRemoteResource(resourceId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: { locators: true, files: { where: { fileRole: FileRole.original, variant: '' } } },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    if (resource.deletedAt) {
      throw new MirrorSkipException('deleted', 'Cannot download a deleted resource');
    }
    if (resource.files.length) {
      throw new MirrorSkipException('already_local', 'Resource already has a local original file');
    }
    const locator = resource.locators.find((item) => item.locatorType === LocatorType.download);
    if (!locator) {
      throw new MirrorSkipException('no_source_url', 'Resource has no downloadable source URL');
    }
    // 批量接口需要把「没有来源配置」与其它策略拒绝区分开；单资源接口的
    // 状态码与文案保持不变（assertDownloadAllowed 内部同样会拒绝无来源的情况）。
    if (!resource.sourceId) {
      throw new MirrorSkipException('no_source', 'Download requires a source configuration');
    }

    // Clicking "download locally" is the explicit manual review required by
    // metadata-only sources. The source's mirror_file policy is still enforced.
    await this.assertDownloadAllowed(resource.sourceId, AcquisitionMode.mirror_file, true);
    return this.enqueueDownloadJob(resourceId, resource.sourceId, { resetAttempts: true });
  }

  /**
   * 批量把用户选中的远程资源加入本地下载队列。
   *
   * 逐条复用单资源入口，来源限速、策略门禁与手动审核语义完全一致；
   * 单个资源失败不影响其余资源，被跳过的资源会带上原因返回给前端提示。
   */
  async mirrorRemoteResources(resourceIds: string[]): Promise<{
    resourceIds: string[];
    queued: number;
    skipped: number;
    skippedResources: MirrorSkipDetail[];
  }> {
    const ids = [...new Set(resourceIds)];
    if (ids.length > MAX_BATCH_MIRROR_RESOURCES) {
      throw new BadRequestException(
        `A single batch can mirror at most ${MAX_BATCH_MIRROR_RESOURCES} resources; split the selection into smaller batches`,
      );
    }
    const skippedResources: MirrorSkipDetail[] = [];
    let queued = 0;
    for (const id of ids) {
      try {
        await this.mirrorRemoteResource(id);
        queued += 1;
      } catch (error) {
        const detail = this.describeMirrorSkip(id, error);
        if (detail.reason === 'error') {
          this.logger.warn(`Failed to queue mirror for ${id}: ${detail.message}`);
        }
        skippedResources.push(detail);
      }
    }
    return { resourceIds: ids, queued, skipped: skippedResources.length, skippedResources };
  }

  private describeMirrorSkip(id: string, error: unknown): MirrorSkipDetail {
    if (error instanceof MirrorSkipException) {
      return { id, reason: error.skipReason, message: error.message };
    }
    if (error instanceof NotFoundException) {
      return { id, reason: 'not_found', message: error.message };
    }
    if (error instanceof BadRequestException) {
      return { id, reason: 'policy', message: error.message };
    }
    return {
      id,
      reason: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  /**
   * 后台补漏：重排到期（nextDownloadAttemptAt 已过）的失败下载。
   *
   * 只处理无需人工审核、来源仍启用且策略允许 mirror_file 的资源；同一资源
   * 已有排队任务时由幂等键复用，不会重复入队。返回本轮入队数量。
   *
   * 允许模式必须在这里过滤：任务执行时的 assertDownloadAllowed 一旦拒绝，
   * 失败路径不会累加 downloadAttempts/nextDownloadAttemptAt，下一轮补漏会
   * 再次为同一资源建出注定失败的任务。
   */
  async scheduleFailedDownloadRetries(batchSize = 20): Promise<number> {
    const now = new Date();
    const candidates = await this.prisma.resource.findMany({
      where: {
        acquisitionMode: AcquisitionMode.metadata_only,
        deletedAt: null,
        createdAt: { lte: new Date(now.getTime() - RETRY_SWEEP_MIN_AGE_MS) },
        files: { none: { fileRole: FileRole.original, variant: '' } },
        locators: {
          some: {
            locatorType: LocatorType.download,
            lastError: { not: null },
            downloadAttempts: { lt: DOWNLOAD_RETRY_MAX_ATTEMPTS },
            OR: [{ nextDownloadAttemptAt: null }, { nextDownloadAttemptAt: { lte: now } }],
          },
        },
        sourceId: { not: null },
        sourceRecord: {
          enabled: true,
          requiresReview: false,
          // allowedModes 是逗号分隔字符串：contains 只做粗筛，值集合里没有
          // 其他包含 "mirror_file" 的合法模式，因此不会误放行。
          allowedModes: { contains: AcquisitionMode.mirror_file },
        },
      },
      select: { id: true, sourceId: true },
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });

    let queued = 0;
    for (const candidate of candidates) {
      try {
        await this.enqueueDownloadJob(candidate.id, candidate.sourceId);
        queued += 1;
      } catch (error) {
        this.logger.warn(
          `Failed to enqueue download retry for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return queued;
  }

  /**
   * 手动批量重试失败下载（超过自动补漏上限的资源也包含在内）。
   *
   * 候选集必须只含有资格入队的资源：
   * - 来源策略门槛下沉到查询。被策略跳过的资源不会改变任何状态，若留在候选集里，
   *   每次调用都会重新取到同一批头部资源，后面的可重试资源永远排不上。
   * - 已有排队/执行中下载任务的资源不再进入候选集，否则同一批头部资源会反复占满
   *   limit；它们的数量仍计入 queued（这些资源确实「已在队列里」）。
   *
   * 返回值保持原有语义：skipped 是策略不允许、根本无法重试的资源数量，
   * 前端据此提示「来源已禁用或不允许镜像下载」。它统计所有匹配筛选的资源，
   * 不受 limit 限制；queued 则包含本轮新入队和此前已在队列中的资源。
   *
   * 循环里仍逐条走来源策略门禁（查询与校验之间来源配置可能变化），
   * 极端情况下的拒绝记为 skipped，不会建任务。
   */
  async retryFailedDownloads(params: { sourceId?: string; limit?: number } = {}): Promise<{
    queued: number;
    skipped: number;
  }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const baseWhere: Prisma.ResourceWhereInput = {
      acquisitionMode: AcquisitionMode.metadata_only,
      deletedAt: null,
      files: { none: { fileRole: FileRole.original, variant: '' } },
      locators: {
        some: { locatorType: LocatorType.download, lastError: { not: null } },
      },
      sourceId: params.sourceId ?? { not: null },
    };
    // 与 assertDownloadAllowed(..., manuallyReviewed=true) 的放行条件一致
    const policyAllowed: Prisma.ResourceWhereInput = {
      sourceRecord: {
        enabled: true,
        OR: [
          { allowedModes: { contains: AcquisitionMode.mirror_file } },
          // 手动重试视为显式审核，允许“需审核且仅元数据”的历史来源镜像下载
          {
            requiresReview: true,
            allowedModes: { contains: AcquisitionMode.metadata_only },
          },
        ],
      },
    };
    const activeDownloadJob: Prisma.IngestionJobWhereInput = {
      jobType: IngestionJobType.download_file,
      status: {
        in: [IngestionJobStatus.pending, IngestionJobStatus.processing],
      },
    };

    const [total, policyEligible, alreadyQueued, candidates] = await Promise.all([
      this.prisma.resource.count({ where: baseWhere }),
      this.prisma.resource.count({ where: { ...baseWhere, ...policyAllowed } }),
      this.prisma.resource.count({
        where: {
          ...baseWhere,
          ...policyAllowed,
          ingestionJobs: { some: activeDownloadJob },
        },
      }),
      this.prisma.resource.findMany({
        where: {
          ...baseWhere,
          ...policyAllowed,
          ingestionJobs: { none: activeDownloadJob },
        },
        select: { id: true, sourceId: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    ]);

    let queued = alreadyQueued;
    let skipped = total - policyEligible;
    for (const candidate of candidates) {
      try {
        await this.assertDownloadAllowed(candidate.sourceId, AcquisitionMode.mirror_file, true);
        await this.enqueueDownloadJob(candidate.id, candidate.sourceId, { resetAttempts: true });
        queued += 1;
      } catch (error) {
        skipped += 1;
        this.logger.warn(
          `Skip download retry for ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { queued, skipped };
  }

  /** 下载任务入队（幂等：同一资源已有排队/执行中的任务时直接复用） */
  private async enqueueDownloadJob(
    resourceId: string,
    sourceId: string | null,
    options: { resetAttempts?: boolean } = {},
  ) {
    if (options.resetAttempts) {
      // 手动重试是用户的明确决定：清零自动补漏预算，失败后能重新走完整退避，
      // 而不是卡在「已达到上限、nextDownloadAttemptAt = null」永远不再自动重试。
      await this.prisma.resourceLocator.updateMany({
        where: { resourceId, locatorType: LocatorType.download },
        data: { downloadAttempts: 0, nextDownloadAttemptAt: null },
      });
    }
    const request: DownloadResourceRequest = { resourceId };
    const idempotencyKey = createHash('sha256')
      .update(`${IngestionJobType.download_file}:${resourceId}`)
      .digest('hex');
    const existing = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    try {
      return await this.jobRepo.create({
        sourceId: sourceId ?? undefined,
        resourceId,
        jobType: IngestionJobType.download_file,
        request: JSON.stringify(request),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const activeJob = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
        if (activeJob) return activeJob;
      }
      throw error;
    }
  }

  /**
   * 为资源创建页面快照任务（capture_page）
   *
   * 快照保存的是页面 HTML，用于日后追溯"当时抓到的是什么"。
   * 点击即实施方案 §6.2 要求的显式确认；带来源的资源还额外受
   * `archive_snapshot` 来源策略门禁约束。
   */
  async createPageSnapshot(resourceId: string) {
    const resource = await this.prisma.resource.findUnique({
      where: { id: resourceId },
      include: { locators: true },
    });
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    if (resource.deletedAt) throw new BadRequestException('Cannot snapshot a deleted resource');

    const target = this.resolveSnapshotUrl(resource);
    if (!target) throw new BadRequestException('Resource has no page URL to snapshot');
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      throw new BadRequestException(`Invalid snapshot URL: ${target}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Snapshot URL must use http or https');
    }

    if (resource.sourceId) {
      await this.assertDownloadAllowed(resource.sourceId, AcquisitionMode.archive_snapshot, true);
    }

    const normalizedUrl = this.safeUrl.normalize(parsed.toString()).toString();
    const request: CapturePageRequest = { resourceId, url: normalizedUrl };
    const idempotencyKey = createHash('sha256')
      .update(`${IngestionJobType.capture_page}:${resourceId}:${normalizedUrl}`)
      .digest('hex');
    const existing = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    try {
      return await this.jobRepo.create({
        sourceId: resource.sourceId ?? undefined,
        resourceId,
        jobType: IngestionJobType.capture_page,
        request: JSON.stringify(request),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const activeJob = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
        if (activeJob) return activeJob;
      }
      throw error;
    }
  }

  /** 快照目标地址：页面链接优先，其次 API / 下载链接的规范地址 */
  private resolveSnapshotUrl(resource: {
    locators: Array<{
      locatorType: string;
      url: string;
      canonicalUrl?: string | null;
      identityUrl?: string | null;
      isPrimary?: boolean;
    }>;
  }): string | null {
    for (const type of [LocatorType.page, LocatorType.api, LocatorType.download]) {
      const locator = resource.locators.find((item) => item.locatorType === type);
      const candidate = locator?.canonicalUrl || locator?.url;
      if (candidate) return candidate;
    }
    // 少数历史资源只有 identityUrl（导入时未建页面 locator）
    return (
      resource.locators.find((item) => item.isPrimary)?.identityUrl ??
      resource.locators[0]?.identityUrl ??
      null
    );
  }

  /**
   * 创建来源同步任务
   *
   * 校验来源存在、启用且支持同步操作，解析 Source.config 获取当前 cursor，
   * 创建 sync_source 类型的 IngestionJob（幂等）。
   */
  async createSourceSync(sourceId: string) {
    const source = await this.sourceRepo.findById(sourceId);
    if (!source) throw new NotFoundException(`Source ${sourceId} not found`);
    if (!source.enabled) throw new BadRequestException('Source is disabled');
    if (!this.getConnectorForSourceType(source.sourceType)) {
      throw new BadRequestException(
        `Source type "${source.sourceType}" does not support sync operations`,
      );
    }

    // Parse current config to get cursor
    let config: Record<string, unknown> = {};
    try {
      config = source.config ? JSON.parse(source.config) : {};
    } catch {
      // Malformed config — treat as empty
    }
    const cursor = (config.cursor as string | undefined) ?? null;

    const request: SyncSourceRequest = { sourceId, cursor };
    const idempotencyKey = createHash('sha256')
      .update(`${IngestionJobType.sync_source}:${JSON.stringify(request)}`)
      .digest('hex');
    const existing = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
    if (existing) return existing;
    try {
      return await this.jobRepo.create({
        sourceId,
        jobType: IngestionJobType.sync_source,
        request: JSON.stringify(request),
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const activeJob = await this.jobRepo.findActiveByIdempotencyKey(idempotencyKey);
        if (activeJob) return activeJob;
      }
      throw error;
    }
  }

  /**
   * 定时自动同步调度：为"开启自动同步且到期"的来源创建 sync_source 任务。
   *
   * 到期判定：lastSyncedAt + autoSyncIntervalHours <= now；从未同步过的来源立即到期。
   * createSourceSync 按 (sourceId, cursor) 幂等，同一轮扫描不会重复建任务；
   * 同步本身由 syncJobRunning 单飞，不会并发下载。
   * 单个来源调度失败（如同步中被禁用）不影响其余来源。
   */
  async scheduleAutoSyncs(batchSize = 10): Promise<number> {
    const now = Date.now();
    const sources = await this.sourceRepo.findAutoSyncEnabled();
    let created = 0;
    for (const source of sources) {
      if (created >= batchSize) break;
      if (!source.enabled) continue;
      // 无同步连接器的来源类型不支持同步，直接跳过，避免每分钟重复告警
      if (!this.getConnectorForSourceType(source.sourceType)) continue;
      const intervalHours = source.autoSyncIntervalHours;
      if (!intervalHours || intervalHours < 1) continue;
      const due =
        source.lastSyncedAt === null ||
        source.lastSyncedAt.getTime() + intervalHours * 3_600_000 <= now;
      if (!due) continue;
      try {
        const job = await this.createSourceSync(source.id);
        if (job) created++;
      } catch (error) {
        this.logger.warn(
          `Auto-sync scheduling failed for source ${source.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return created;
  }

  private async runLocatorCheck(job: IngestionJob, leaseToken: string): Promise<void> {
    const request = this.parseLocatorCheckRequest(job.request);
    const result = await this.locatorHealthChecker.check(request.url);
    const now = new Date();

    await this.prisma.resourceLocator.update({
      where: { id: request.locatorId },
      data: {
        httpStatus: result.httpStatus > 0 ? result.httpStatus : null,
        // 仅在检查成功时更新元数据，避免错误页面的头信息覆盖原有数据
        ...(result.error === null
          ? {
              contentType: result.contentType,
              contentLength: result.contentLength,
              etag: result.etag,
              lastModified: result.lastModified,
            }
          : {}),
        lastCheckedAt: now,
        lastError: result.error,
      },
    });

    const completed = await this.jobRepo.complete(
      job.id,
      leaseToken,
      job.resourceId ?? null,
      JSON.stringify({
        locatorId: request.locatorId,
        httpStatus: result.httpStatus,
        error: result.error,
      }),
    );
    if (completed)
      this.logger.log(
        `Locator health check completed: ${request.locatorId} → HTTP ${result.httpStatus || 'error'}`,
      );
    else this.logger.warn(`Ingestion job ${job.id} lost its lease before completion`);
  }

  private async runDownloadResourceJob(job: IngestionJob, leaseToken: string): Promise<void> {
    const request = this.parseDownloadResourceRequest(job.request);
    const resource = await this.prisma.resource.findUnique({
      where: { id: request.resourceId },
      include: {
        locators: true,
        files: { where: { fileRole: FileRole.original, variant: '' }, take: 1 },
      },
    });
    if (!resource) throw new NotFoundException(`Resource ${request.resourceId} not found`);
    if (resource.deletedAt) throw new BadRequestException('Cannot download a deleted resource');

    if (resource.files.length) {
      await this.jobRepo.complete(
        job.id,
        leaseToken,
        resource.id,
        JSON.stringify({ status: 'already_downloaded' }),
      );
      return;
    }

    await this.assertDownloadAllowed(resource.sourceId, AcquisitionMode.mirror_file, true);
    const locator = resource.locators.find((item) => item.locatorType === LocatorType.download);
    if (!locator) throw new BadRequestException('Resource has no downloadable source URL');

    // 镜像下载同样按来源配置的下载目录存放，与自动同步保持一致
    const directorySource = resource.sourceId
      ? await this.sourceRepo.findById(resource.sourceId).catch(() => null)
      : null;

    if (directorySource) {
      const waitMs = this.reserveSourceDownloadSlot(directorySource);
      if (waitMs > 0) {
        // 手动任务只有调度器下一次认领时才能再抢槽位，先给同步等待者一个
        // 让出窗口，避免它被同步的 250ms 轮询长期挤在后面。窗口要覆盖
        // nextRunAt 到下一次轮询认领的时间（轮询间隔可配置）。
        const priorityGraceMs = Math.max(
          MANUAL_DOWNLOAD_PRIORITY_GRACE_MS,
          this.pollIntervalMs() * 2 + 1_000,
        );
        this.manualDownloadPriorityUntil.set(
          directorySource.id,
          Date.now() + waitMs + priorityGraceMs,
        );
        // 不在摄入队列里阻塞等待：释放任务并延迟重排，让其它任务先执行。
        // 批量镜像同一来源的大量资源时，这里保证仍按来源速率逐条下载。
        try {
          const released = await this.jobRepo.release(job.id, leaseToken, waitMs + 1_000);
          if (released) {
            this.logger.debug(
              `Deferred manual download ${job.id} for ${waitMs}ms by source rate limit`,
            );
          }
        } catch (error) {
          // 释放失败（例如 SQLite busy）不能让任务被 runNextJob 标记为终态失败：
          // 保持 processing，交给 stale 恢复重新排队即可自动重试。
          this.logger.warn(
            `Failed to defer rate-limited download ${job.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        return;
      }
      // 手动任务拿到槽位，解除优先窗口，同步等待者可以继续。
      this.manualDownloadPriorityUntil.delete(directorySource.id);
    }

    // 手动镜像下载同样记账：这类资源常来自「需要人工审核」的来源，
    // 审核通过后手动下载；记账后即使日后彻底删除，也不会被同步重新下载。
    const ledger =
      locator.externalId && directorySource
        ? { sourceId: resource.sourceId, connectorType: directorySource.sourceType }
        : undefined;

    const result = await this.downloadRemoteFile(
      resource.id,
      locator.id,
      {
        externalId: locator.externalId ?? resource.id,
        url: locator.url,
        canonicalUrl: locator.canonicalUrl ?? undefined,
        resourceType: resource.resourceType,
        mimeType: locator.contentType ?? resource.mimeType,
        title: resource.title,
        description: resource.description,
        authorName: resource.author,
        publisher: resource.source,
        width: resource.width,
        height: resource.height,
        externalCreatedAt: resource.externalCreatedAt,
        rawMetadata: {},
      },
      { id: job.id, leaseToken, completeOnCommit: true },
      directorySource?.downloadDirectory ?? null,
      ledger,
    );
    if (result === 'failed') {
      const failedLocator = await this.prisma.resourceLocator.findUnique?.({
        where: { id: locator.id },
        select: { lastError: true },
      });
      const detail = failedLocator?.lastError;
      throw new BadRequestException(
        detail
          ? `Failed to download the remote resource: ${detail}`
          : 'Failed to download the remote resource',
      );
    }
    this.logger.log(`Mirrored remote resource ${resource.id}`);
  }

  /**
   * 执行页面快照任务
   *
   * 走 SafeUrlService.fetchHtml：DNS-pinning、逐跳重定向校验、内容类型必须是
   * text/html、响应体限量。不执行 JavaScript、不抓子资源，因此快照是"服务端
   * 返回的骨架 HTML"，与浏览器渲染结果不同（这是有意为之的轻量实现，
   * 详见 docs/delivery-notes.md 的限制说明）。
   *
   * 同一资源只保留一份快照（resourceId + fileRole + variant 唯一）：内容未变时
   * 复用已有对象，内容变化时写入新对象并清理旧对象。
   */
  private async runCapturePageJob(job: IngestionJob, leaseToken: string): Promise<void> {
    const request = this.parseCapturePageRequest(job.request);
    const resource = await this.prisma.resource.findUnique({
      where: { id: request.resourceId },
      include: { locators: true },
    });
    if (!resource) throw new NotFoundException(`Resource ${request.resourceId} not found`);
    if (resource.deletedAt) throw new BadRequestException('Cannot snapshot a deleted resource');

    let fetched;
    try {
      fetched = await this.safeUrl.fetchHtml(request.url, {}, SNAPSHOT_MAX_BYTES);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to snapshot ${request.url}: ${detail}`);
    }
    const html = fetched.body;
    if (!html.trim()) throw new BadRequestException('Snapshot response was empty');
    const sha256 = createHash('sha256').update(html, 'utf-8').digest('hex');
    const storageKey = this.storage.generateKey(FileRole.snapshot, sha256, undefined, 'html');
    const existing = await this.prisma.resourceFile.findUnique({
      where: {
        resourceId_fileRole_variant: {
          resourceId: resource.id,
          fileRole: FileRole.snapshot,
          variant: '',
        },
      },
      select: { id: true, storagePath: true },
    });

    await this.touchJob(job.id, leaseToken);
    // 页面内容未变：只刷新页面 locator 的健康信息，不重复写对象与文件记录
    if (existing && existing.storagePath === storageKey) {
      await this.markLocatorSnapshotChecked(resource.locators, fetched.status);
      await this.jobRepo.complete(
        job.id,
        leaseToken,
        resource.id,
        JSON.stringify({ status: 'unchanged', sha256, capturedUrl: fetched.url }),
      );
      return;
    }

    await this.storage.put(storageKey, Buffer.from(html, 'utf-8'));
    const sizeBytes = BigInt(Buffer.byteLength(html, 'utf-8'));
    try {
      await this.prisma.resourceFile.upsert({
        where: {
          resourceId_fileRole_variant: {
            resourceId: resource.id,
            fileRole: FileRole.snapshot,
            variant: '',
          },
        },
        create: {
          resourceId: resource.id,
          fileRole: FileRole.snapshot,
          variant: '',
          storagePath: storageKey,
          mimeType: 'text/html',
          extension: 'html',
          sizeBytes,
        },
        update: {
          storagePath: storageKey,
          mimeType: 'text/html',
          extension: 'html',
          sizeBytes,
        },
      });
    } catch (error) {
      // 对象已写入但记录未落库：与下载一致，按引用情况回收，避免留下孤儿快照。
      await this.deleteStorageKeyIfUnreferenced(storageKey);
      throw error;
    }
    // 旧快照对象与新的 hash 不同才会残留，best-effort 清理。
    // 快照 key 按内容哈希生成：内容相同的快照可能被多条资源共用，仍有引用时保留。
    // 引用查询失败时保守保留（宁可留孤儿文件，也不误删其它资源的快照）。
    if (existing && existing.storagePath !== storageKey) {
      let stillReferenced = true;
      try {
        const references = await this.fileRepo.findStoragePathReferences([existing.storagePath]);
        stillReferenced = references.has(existing.storagePath);
      } catch {
        stillReferenced = true;
      }
      if (!stillReferenced) {
        await this.storage.delete(existing.storagePath).catch(() => undefined);
      }
    }
    await this.markLocatorSnapshotChecked(resource.locators, fetched.status);

    await this.jobRepo.complete(
      job.id,
      leaseToken,
      resource.id,
      JSON.stringify({
        status: existing ? 'updated' : 'captured',
        sha256,
        sizeBytes: Number(sizeBytes),
        capturedUrl: fetched.url,
      }),
    );
    this.logger.log(`Captured page snapshot of ${fetched.url} for resource ${resource.id}`);
  }

  /** 快照成功即证明页面可达：把页面 locator 的健康信息一并刷新 */
  private async markLocatorSnapshotChecked(
    locators: Array<{ id: string; locatorType: string }>,
    httpStatus: number,
  ): Promise<void> {
    const pageLocator = locators.find((item) => item.locatorType === LocatorType.page);
    if (!pageLocator) return;
    await this.prisma.resourceLocator
      .update({
        where: { id: pageLocator.id },
        data: {
          httpStatus,
          lastCheckedAt: new Date(),
          lastError: null,
          contentType: 'text/html',
        },
      })
      .catch(() => undefined);
  }

  private parseLinkImportRequest(serialized: string): LinkImportRequest {
    const request: unknown = JSON.parse(serialized);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof (request as { url?: unknown }).url !== 'string'
    ) {
      throw new BadRequestException('Invalid link import request');
    }
    const value = request as LinkImportRequest;
    return { ...value, url: this.safeUrl.normalize(value.url).toString() };
  }

  private parseLocatorCheckRequest(serialized: string): { locatorId: string; url: string } {
    const request: unknown = JSON.parse(serialized);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof (request as { locatorId?: unknown }).locatorId !== 'string' ||
      typeof (request as { url?: unknown }).url !== 'string'
    ) {
      throw new BadRequestException('Invalid locator check request');
    }
    const value = request as { locatorId: string; url: string };
    return { locatorId: value.locatorId, url: this.safeUrl.normalize(value.url).toString() };
  }

  private parseDownloadResourceRequest(serialized: string): DownloadResourceRequest {
    const request: unknown = JSON.parse(serialized);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof (request as { resourceId?: unknown }).resourceId !== 'string'
    ) {
      throw new BadRequestException('Invalid remote download request');
    }
    return request as DownloadResourceRequest;
  }

  private parseCapturePageRequest(serialized: string): CapturePageRequest {
    const request: unknown = JSON.parse(serialized);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof (request as { resourceId?: unknown }).resourceId !== 'string' ||
      typeof (request as { url?: unknown }).url !== 'string'
    ) {
      throw new BadRequestException('Invalid page snapshot request');
    }
    return request as CapturePageRequest;
  }

  private async assertLinkImportAllowed(sourceId: string, targetUrl: string): Promise<void> {
    const source = await this.sourceRepo.findById(sourceId);
    if (!source) throw new NotFoundException(`Source ${sourceId} not found`);
    if (!source.enabled) throw new BadRequestException('Source is disabled');
    const allowedModes = source.allowedModes.split(',').map((mode) => mode.trim());
    if (!allowedModes.includes(AcquisitionMode.link_only)) {
      throw new BadRequestException('Source does not allow link-only imports');
    }
    if (source.baseUrl && source.sourceType !== SourceType.rss) {
      // RSS 来源的 baseUrl 是 Feed 地址（例如 https://example.com/feed.xml），
      // 不构成站内路径范围；条目链接（文章页、附件）通常不在 /feed.xml 之下，
      // 甚至可能由第三方 feed 托管在别的域名。对 RSS 来源不做路径/域名限制。
      const baseUrl = this.safeUrl.normalize(source.baseUrl);
      const target = this.safeUrl.normalize(targetUrl);
      if (!isUrlWithinSourceBase(baseUrl, target)) {
        throw new BadRequestException('URL is outside the configured source base URL');
      }
    }
  }

  private async createLinkResource(
    request: LinkImportRequest,
    metadata: Awaited<ReturnType<LinkMetadataConnector['inspect']>>,
    ingestionJobId: string,
  ): Promise<string> {
    const source = request.sourceId ? await this.sourceRepo.findById(request.sourceId) : null;
    const resource = await this.prisma.resource.create({
      data: {
        title: request.title ?? metadata.title,
        description: metadata.description,
        originalFilename: new URL(metadata.finalUrl).hostname,
        resourceType: ResourceType.other,
        mimeType: metadata.contentType ?? 'text/html',
        extension: 'url',
        sizeBytes: BigInt(0),
        source: metadata.publisher,
        category: request.categoryId ? { connect: { id: request.categoryId } } : undefined,
        acquisitionMode: AcquisitionMode.link_only,
        sourceRecord: source ? { connect: { id: source.id } } : undefined,
        processingStatus: ProcessingStatus.completed,
        locators: {
          create: [
            {
              sourceId: source?.id,
              locatorType: LocatorType.page,
              url: metadata.finalUrl,
              canonicalUrl: metadata.canonicalUrl,
              identityUrl: metadata.finalUrl,
              isPrimary: true,
              httpStatus: metadata.httpStatus,
              contentType: metadata.contentType,
              contentLength: metadata.contentLength,
              etag: metadata.etag,
              lastModified: metadata.lastModified,
              lastCheckedAt: new Date(),
            },
            ...(metadata.previewUrl
              ? [
                  {
                    sourceId: source?.id,
                    locatorType: LocatorType.preview,
                    url: metadata.previewUrl,
                  },
                ]
              : []),
            ...(metadata.faviconUrl
              ? [
                  {
                    sourceId: source?.id,
                    locatorType: LocatorType.favicon,
                    url: metadata.faviconUrl,
                  },
                ]
              : []),
          ],
        },
        provenance: {
          create: {
            sourceId: source?.id,
            ingestionJobId,
            connectorType: this.linkMetadataConnector.type,
            connectorVersion: '0.1',
            originalUrl: metadata.requestedUrl,
            publisher: metadata.publisher,
            rawMetadata: JSON.stringify(metadata.rawMetadata),
          },
        },
      },
    });
    return resource.id;
  }

  private async createOrReuseLinkResource(
    request: LinkImportRequest,
    metadata: Awaited<ReturnType<LinkMetadataConnector['inspect']>>,
    ingestionJobId: string,
  ): Promise<string> {
    try {
      return await this.createLinkResource(request, metadata, ingestionJobId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.resourceRepo.findByIdentityUrl(metadata.finalUrl);
        if (existing) {
          return this.reuseLinkResource(existing.resourceId, existing.resource.deletedAt, request);
        }
      }
      throw error;
    }
  }

  private async reuseLinkResource(
    resourceId: string,
    deletedAt: Date | null,
    request: LinkImportRequest,
  ): Promise<string> {
    if (deletedAt || request.title || request.categoryId) {
      await this.prisma.resource.update({
        where: { id: resourceId },
        data: {
          deletedAt: deletedAt ? null : undefined,
          // 恢复已删除资源时，同时重置处理状态
          processingStatus: deletedAt ? ProcessingStatus.completed : undefined,
          title: request.title,
          category: request.categoryId ? { connect: { id: request.categoryId } } : undefined,
        },
      });
      // 这条路径直接绕过 ResourceService 复活了回收站资源，统计缓存必须同步失效
      if (deletedAt) this.resourceService.invalidateTrashStats();
    }
    return resourceId;
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException(`Category ${categoryId} not found`);
  }

  /**
   * 执行来源同步任务
   *
   * 流程：
   * 1. 从 Source.config 解析 filters / limit / maxPages
   * 2. 调用 connector.sync() 逐页获取数据（最多 maxPages 页，页间用 cursor 续传）
   * 3. 逐条 upsertRemoteResource（按 externalId 去重）并下载原图文件（受控并发）
   * 4. 将最终 nextCursor 写回 Source.config
   * 5. 更新 Source.lastSyncedAt / lastSyncStatus / lastSyncError
   *
   * 下载失败只记录到 locator.lastError 并计数，不中断整页同步。
   * 同步期间周期性刷新任务 lease（startedAt），避免被 stale 恢复重置。
   */
  private async runSyncSourceJob(job: IngestionJob, leaseToken: string): Promise<void> {
    const request = this.parseSyncSourceRequest(job.request);
    const source = await this.sourceRepo.findById(request.sourceId);
    if (!source) throw new BadRequestException(`Source ${request.sourceId} not found`);
    if (!source.enabled) throw new BadRequestException('Source is disabled');

    const connector = this.getConnectorForSourceType(source.sourceType);
    if (!connector) {
      throw new BadRequestException(
        `No connector registered for source type "${source.sourceType}"`,
      );
    }

    // Parse config for filters
    // 前端 Civitai 配置将 sort/period/nsfw 存储在顶层，也兼容 filters 嵌套格式
    let config: Record<string, unknown> = {};
    try {
      config = source.config ? JSON.parse(source.config) : {};
    } catch {
      // Malformed config — treat as empty
    }
    const filters: Record<string, unknown> = (config.filters ?? {}) as Record<string, unknown>;
    // 顶层 sort/period/nsfw 作为 filters 的 fallback
    if (!filters.sort && config.sort) filters.sort = config.sort;
    if (!filters.period && config.period) filters.period = config.period;
    if (filters.nsfw === undefined && config.nsfw !== undefined) filters.nsfw = config.nsfw;
    // GitHub 等连接器的仓库定位同样支持顶层 repo
    if (!filters.repo && config.repo) filters.repo = config.repo;
    // RSS 连接的 Feed 地址直接取来源的 baseUrl（站点的 feed 链接）
    if (!filters.feedUrl && source.baseUrl) filters.feedUrl = source.baseUrl;

    // 每次同步最多连续抓取多少页（config.maxPages，默认 1），每页最多 limit 条。
    // 页间通过 cursor 续传，抓完的页数越多耗时越长（后台执行，任务心跳保持）。
    const maxPages = this.clampSyncMaxPages(config.maxPages);
    // 只接受有限数字；历史/手工编辑的 config 里可能是字符串，避免把 NaN 传给连接器
    const limit =
      typeof config.limit === 'number' && Number.isFinite(config.limit) ? config.limit : undefined;
    // 下载并发取自来源 maxConcurrency，未配置时用模块级默认
    const concurrency = this.resolveDownloadConcurrency(source.maxConcurrency);
    // 与手动镜像共用同一份来源速率预算：同步下载在进程内阻塞等待槽位
    const waitHeartbeatMs = this.resolveJobHeartbeatIntervalMs();
    let lastWaitHeartbeatAt = Date.now();
    const waitForDownloadSlot = () =>
      this.waitForSourceDownloadSlot(source, async () => {
        const now = Date.now();
        if (now - lastWaitHeartbeatAt >= waitHeartbeatMs) {
          lastWaitHeartbeatAt = now;
          await this.touchJob(job.id, leaseToken).catch((error) => {
            this.logger.warn(
              `Failed to heartbeat waiting sync job ${job.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
        await this.assertSyncJobActive(job.id, leaseToken);
      });

    try {
      // 逐页拉取，直到达到页数上限或 API 没有下一页。
      // 注意首页 cursor 可能为 null（从头拉取），因此用 hasMore 标志而非 cursor 判空。
      let cursor = request.cursor;
      let hasMore = true;
      let downloadedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;
      let itemsProcessed = 0;
      let totalItems: number | null = null;
      let pagesProcessed = 0;
      let lastProgressAt = 0;
      const progressResult = () =>
        JSON.stringify({
          sourceId: source.id,
          state: 'downloading',
          pagesProcessed,
          itemsProcessed,
          downloadedCount,
          failedCount,
          skippedCount,
          totalItems,
          maxPages,
        });
      const saveProgress = async (force = false) => {
        if (!force && Date.now() - lastProgressAt < 1000) return;
        lastProgressAt = Date.now();
        const progressUpdated = this.jobRepo.updateProgress
          ? await this.jobRepo.updateProgress(job.id, leaseToken, progressResult())
          : true;
        if (!progressUpdated) {
          throw new SyncJobCanceledError();
        }
      };

      for (let page = 0; page < maxPages && hasMore; page++) {
        await this.assertSyncJobActive(job.id, leaseToken);
        await this.touchJob(job.id, leaseToken);
        const pageData = await connector.sync({
          cursor,
          limit,
          filters,
        });
        totalItems = pageData.totalItems ?? totalItems;
        await saveProgress(true);

        // 先批量查出本页哪些条目已经有预览定位器：存量补齐后，逐条 findFirst
        // 会变成每次同步都要重复付的固定开销。
        const previewReady = await this.findExternalIdsWithPreviewLocator(
          pageData.items,
          source.id,
          connector.type,
        );

        // 受控并发：同步 + 下载每条远端资源，单条失败不影响整页
        await this.mapWithConcurrency(pageData.items, concurrency, async (remote) => {
          await this.assertSyncJobActive(job.id, leaseToken);
          await this.touchJob(job.id, leaseToken);
          const result = await this.syncRemoteWithDownload(
            remote,
            source,
            job.id,
            leaseToken,
            connector.type,
            async () => {
              await this.assertSyncJobActive(job.id, leaseToken);
              await waitForDownloadSlot();
              await this.assertSyncJobActive(job.id, leaseToken);
            },
            previewReady,
          );
          if (result === 'downloaded') downloadedCount++;
          else if (result === 'failed') failedCount++;
          else skippedCount++;
          itemsProcessed++;
          await saveProgress();
          return result;
        });

        pagesProcessed++;
        await saveProgress(true);
        // 防呆：API 未推进 cursor（返回 null 或与当前相同）时终止，避免死循环
        hasMore = pageData.nextCursor !== null && pageData.nextCursor !== cursor;
        cursor = pageData.nextCursor;
      }

      // Persist the final cursor and sync result back to Source.
      // 同步期间用户可能编辑了来源（改筛选/数量/并发等）。为避免把用户的最新配置
      // 覆盖掉，写回前重新读取当前 config：仅当与本同步启动时的一致时才合并 cursor，
      // 否则保留用户的新配置（cursor 不写回，下次同步按新配置幂等续走）。
      const latestSource = await this.sourceRepo.findById(source.id);
      let latestConfig: Record<string, unknown> = {};
      try {
        latestConfig = latestSource?.config ? JSON.parse(latestSource.config) : {};
      } catch {
        // Malformed config — keep empty
      }
      const updatedConfig =
        JSON.stringify(latestConfig) === JSON.stringify(config)
          ? { ...config, cursor }
          : latestConfig;
      await this.sourceRepo.update(source.id, {
        config: JSON.stringify(updatedConfig),
      });
      await this.sourceRepo.updateSyncResult(source.id, {
        lastSyncedAt: new Date(),
        lastSyncStatus: 'completed',
        lastSyncError: null,
      });

      // Complete the job
      const completed = await this.jobRepo.complete(
        job.id,
        leaseToken,
        null, // sync_source jobs don't produce a single resourceId
        JSON.stringify({
          sourceId: source.id,
          pagesProcessed,
          itemsProcessed,
          downloadedCount,
          failedCount,
          skippedCount,
          nextCursor: cursor,
          totalItems,
        }),
      );

      if (completed) {
        this.logger.log(
          `Synced ${pagesProcessed} page(s), ${itemsProcessed} item(s) (${downloadedCount} downloaded, ${failedCount} failed, ${skippedCount} skipped) from ${source.name} (cursor: ${request.cursor ?? 'initial'} -> ${cursor ?? 'end'})`,
        );
      } else {
        this.logger.warn(`Ingestion job ${job.id} lost its lease before completion`);
      }
    } catch (error) {
      if (error instanceof SyncJobCanceledError) {
        await this.sourceRepo
          .updateSyncResult(source.id, {
            lastSyncedAt: new Date(),
            lastSyncStatus: 'canceled',
            lastSyncError: null,
          })
          .catch(() => undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // 同步整体失败时，把失败原因写到来源上供 UI 展示
      await this.sourceRepo
        .updateSyncResult(source.id, {
          lastSyncedAt: new Date(),
          lastSyncStatus: 'failed',
          lastSyncError: message,
        })
        .catch(() => undefined);
      throw error; // 交给 runNextJob 将任务标记为 failed
    }
  }

  /**
   * 同步单条远端资源并下载原图
   *
   * - 台账已记「下载过」→ skipped（资源被彻底删除后依然生效，见 SourceItemLedger）
   * - 需要人工审核的来源：只记录元数据，不自动下载文件
   * - 已存在且有原文件 → skipped
   * - 已存在但无原文件（上次下载失败）→ 重试下载
   * - 新建资源 → 下载原图
   */
  private async syncRemoteWithDownload(
    remote: import('./connectors/resource-connector.interface').RemoteResource,
    source: {
      id: string;
      name: string;
      requiresReview?: boolean;
      downloadDirectory?: string | null;
      downloadCategoryId?: string | null;
    },
    ingestionJobId: string,
    leaseToken: string,
    connectorType: string,
    waitForDownloadSlot: () => Promise<void>,
    previewReady: ReadonlySet<string> = new Set(),
  ): Promise<'downloaded' | 'skipped' | 'failed'> {
    try {
      // 补写历史资源缺失的远端预览定位器。必须放在台账判断之前：已下载过、
      // 本次会被跳过的条目同样需要补齐缩略图。整页预取已确认有预览的条目跳过。
      if (!previewReady.has(remote.externalId)) {
        await this.ensureRemotePreviewLocator(remote, source.id, connectorType);
      }

      // 台账优先：该条目曾成功下载过，即使资源已被彻底删除也不再重复下载。
      // 用户若想重新下载，清除同步记录（clearSyncHistory）即可。
      if (await this.isLedgerDownloaded(connectorType, remote.externalId)) {
        return 'skipped';
      }

      const upserted = await this.upsertRemoteResource(
        remote,
        source,
        ingestionJobId,
        connectorType,
      );
      if (!upserted) return 'skipped';

      // 需要人工审核的来源：仅保留元数据，不触发自动下载
      if (source.requiresReview) return 'skipped';
      // 已存在且有原文件 → 跳过
      if (!upserted.isNew && (await this.resourceHasOriginalFile(upserted.resourceId))) {
        return 'skipped';
      }

      await waitForDownloadSlot();
      return await this.downloadRemoteFile(
        upserted.resourceId,
        upserted.downloadLocatorId,
        remote,
        {
          id: ingestionJobId,
          leaseToken,
        },
        source.downloadDirectory,
        { sourceId: source.id, connectorType },
      );
    } catch (error) {
      if (error instanceof SyncJobCanceledError) throw error;
      this.logger.warn(
        `Failed to sync resource ${remote.externalId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }

  /**
   * 下载远端文件并写入 ResourceFile(original)
   *
   * 取文件本身交给 DirectDownloadConnector（SSRF 逐跳校验、限量流式落盘、
   * 魔数识别 MIME、写正式存储）；这里只负责任务控制与资源记录：取消/租约心跳、
   * 事务更新 Resource + 建原文件记录 + 更新 locator、入队元数据检测。
   * 下载失败记录到 locator.lastError 并返回 'failed'，不中断整批同步。
   */
  private async downloadRemoteFile(
    resourceId: string,
    locatorId: string | null,
    remote: import('./connectors/resource-connector.interface').RemoteResource,
    jobControl?: DownloadJobControl,
    downloadDirectory?: string | null,
    ledger?: { sourceId: string | null; connectorType: string },
  ): Promise<'downloaded' | 'failed'> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TOTAL_TIMEOUT_MS);
    let canceled = false;
    // 心跳间隔跟随 stale 超时配置：默认 60s 时取 5s；配置被调小时（或非法值）
    // 也不能让心跳失效，否则长下载又会被 stale 恢复中途重置。
    const heartbeatIntervalMs = this.resolveJobHeartbeatIntervalMs();
    // 任务刚被认领时 startedAt 已是新的，不需要立刻再写一次心跳
    let lastHeartbeatAt = Date.now();
    const assertJobActive = async () => {
      if (!jobControl) return;
      const now = Date.now();
      if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
        lastHeartbeatAt = now;
        // 心跳失败不直接中断下载：若任务确实被取消/重置，紧接着的
        // assertSyncJobActive 会抛 SyncJobCanceledError，下载仍会停止。
        await this.touchJob(jobControl.id, jobControl.leaseToken).catch((error) => {
          this.logger.warn(
            `Failed to heartbeat download job ${jobControl.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      await this.assertSyncJobActive(jobControl.id, jobControl.leaseToken);
    };
    // 每 500ms 探测一次任务是否已取消：取消时立即中止 fetch，
    // 否则要等到下一次读流才会发现。
    const cancellationPoll = jobControl
      ? setInterval(() => {
          void assertJobActive().catch((error) => {
            if (error instanceof SyncJobCanceledError) {
              canceled = true;
              controller.abort();
            }
          });
        }, 500)
      : null;

    try {
      // 本次尝试已成功写入正式存储、但尚未（或未能）落库的对象 key。
      // 事务失败 / 取消 / 准备重试时必须回收，否则会留下没有 resource_files 引用的孤儿文件。
      let downloadedStorageKey: string | null = null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const downloaded = await this.directDownload.download({
            url: remote.url,
            expectedResourceType: remote.resourceType,
            declaredMimeType: remote.mimeType ?? null,
            downloadDirectory,
            signal: controller.signal,
            onCheckpoint: assertJobActive,
          });
          downloadedStorageKey = downloaded.storageKey;
          // 下载期间（尤其是落盘阶段）可能已被取消：返回后立即再确认一次，
          // 此时对象已写入，取消/异常由下面的 catch 按引用情况回收。
          await assertJobActive();

          // 事务：更新资源元数据 + 建原文件记录 + 更新 locator + 按 sha256 查重
          const commit = await this.commitDownloadedFile({
            resourceId,
            locatorId,
            remote,
            sha256: downloaded.sha256,
            mimeType: downloaded.mimeType,
            extension: downloaded.extension,
            resourceType: downloaded.resourceType,
            sizeBytes: BigInt(downloaded.sizeBytes),
            storageKey: downloaded.storageKey,
            originalFilename: this.remoteOriginalFilename(
              remote.url,
              remote.externalId,
              downloaded.extension,
            ),
            ledger: ledger ? { ...ledger, externalId: remote.externalId } : undefined,
            completion: jobControl?.completeOnCommit
              ? {
                  id: jobControl.id,
                  leaseToken: jobControl.leaseToken,
                  resourceId,
                  result: JSON.stringify({ status: 'downloaded' }),
                }
              : undefined,
          });

          // 并发同步已创建同一条 resourceFile 时事务会继续提交（P2002 忽略），
          // 但本次写入的 key 可能因下载目录不同而没有被任何记录引用，需按引用情况回收。
          if (commit.fileAlreadyExisted) {
            await this.deleteStorageKeyIfUnreferenced(downloaded.storageKey);
          }
          // 事务已提交：对象现在归数据库记录所有，后续失败不再回滚存储。
          downloadedStorageKey = null;

          // 入队元数据检测（图片会链式生成缩略图），与上传流程一致
          await this.scheduler.enqueue(JobType.detect_metadata, resourceId).catch((error) => {
            this.logger.warn(
              `Failed to enqueue metadata detection for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });

          return 'downloaded';
        } catch (error) {
          // 本次尝试写入的对象还没有数据库记录指向它（事务已回滚，或下载后的取消
          // 检查失败）：无论取消、准备重试还是最终失败，都先按引用情况回收。
          if (downloadedStorageKey) {
            await this.deleteStorageKeyIfUnreferenced(downloadedStorageKey);
            downloadedStorageKey = null;
          }
          if (canceled || error instanceof SyncJobCanceledError) {
            throw new SyncJobCanceledError();
          }
          const message = error instanceof Error ? error.message : String(error);
          const canRetryInline =
            attempt < INLINE_DOWNLOAD_RETRY_DELAYS_MS.length &&
            this.isTransientDownloadError(message);
          if (!canRetryInline) {
            this.logger.warn(`Download ${remote.externalId} (${remote.url}) failed: ${message}`);
            await this.markLocatorError(locatorId, message).catch(() => undefined);
            return 'failed';
          }
          this.logger.warn(
            `Download ${remote.externalId} (${remote.url}) failed on attempt ${attempt + 1}, retrying: ${message}`,
          );
          await this.sleep(INLINE_DOWNLOAD_RETRY_DELAYS_MS[attempt]);
          await assertJobActive();
        }
      }
    } finally {
      clearTimeout(timeout);
      if (cancellationPoll) clearInterval(cancellationPoll);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 只有网络层/上游 5xx 才值得立刻重试；策略拒绝、4xx、超限重试也不会变好 */
  private isTransientDownloadError(message: string): boolean {
    if (
      /blocked network address|File too large|Unsupported protocol|HTTP 4\d\d|no location|does not allow|manual review/i.test(
        message,
      )
    ) {
      return false;
    }
    return /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|other side closed|terminated|timeout|timed out|UND_ERR|HTTP 5\d\d/i.test(
      message,
    );
  }

  /** 事务提交下载结果：更新资源 + 建原文件 + 更新 locator + 按 sha256 查重 + 记台账 */
  private async commitDownloadedFile(args: {
    resourceId: string;
    locatorId: string | null;
    remote: import('./connectors/resource-connector.interface').RemoteResource;
    sha256: string;
    mimeType: string;
    extension: string;
    resourceType: string;
    sizeBytes: bigint;
    storageKey: string;
    originalFilename: string;
    /** 下载成功后在台账里记一笔，保证删除资源后不再重复下载 */
    ledger?: { sourceId: string | null; connectorType: string; externalId: string };
    completion?: {
      id: string;
      leaseToken: string;
      resourceId: string;
      result: string;
    };
  }): Promise<{ fileAlreadyExisted: boolean }> {
    // 并发同步已经建过原文件记录时不会报错，但本次写入的存储对象可能因此没有被引用，
    // 由调用方据此决定是否回收。
    let fileAlreadyExisted = false;
    await this.prisma.$transaction(async (tx) => {
      const duplicate = await tx.resource.findFirst({
        where: { sha256: args.sha256, deletedAt: null },
        select: { id: true },
      });

      await tx.resource.update({
        where: { id: args.resourceId },
        data: {
          sha256: args.sha256,
          mimeType: args.mimeType,
          extension: args.extension,
          resourceType: args.resourceType,
          sizeBytes: args.sizeBytes,
          originalFilename: args.originalFilename,
          acquisitionMode: AcquisitionMode.mirror_file,
          processingStatus: ProcessingStatus.pending, // 等待处理流水线（缩略图等）
          duplicateOfId: duplicate && duplicate.id !== args.resourceId ? duplicate.id : undefined,
        },
      });

      await tx.resourceFile
        .create({
          data: {
            resourceId: args.resourceId,
            fileRole: FileRole.original,
            variant: '',
            storagePath: args.storageKey,
            mimeType: args.mimeType,
            extension: args.extension,
            sizeBytes: args.sizeBytes,
            width: args.remote.width ?? undefined,
            height: args.remote.height ?? undefined,
          },
        })
        .catch((error) => {
          // 并发同步已创建该原文件记录（唯一约束 resourceId+fileRole+variant）→ 视为已下载，继续
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            fileAlreadyExisted = true;
            return;
          }
          throw error;
        });

      // 台账与文件记录同事务落库：要么「文件 + 已下载记录」都在，要么都不在，
      // 不会出现文件已落盘但台账缺失、删除后又重复下载的情况。
      if (args.ledger) {
        await tx.sourceItemLedger.upsert({
          where: {
            connectorType_externalId: {
              connectorType: args.ledger.connectorType,
              externalId: args.ledger.externalId,
            },
          },
          create: {
            connectorType: args.ledger.connectorType,
            externalId: args.ledger.externalId,
            sourceId: args.ledger.sourceId,
            resourceId: args.resourceId,
            state: SYNC_LEDGER_DOWNLOADED,
            sha256: args.sha256,
            sizeBytes: args.sizeBytes,
          },
          update: {
            state: SYNC_LEDGER_DOWNLOADED,
            sha256: args.sha256,
            sizeBytes: args.sizeBytes,
            resourceId: args.resourceId,
          },
        });
      }

      if (args.locatorId) {
        await tx.resourceLocator.update({
          where: { id: args.locatorId },
          data: {
            httpStatus: 200,
            lastCheckedAt: new Date(),
            lastError: null,
            contentType: args.mimeType,
            downloadAttempts: 0,
            nextDownloadAttemptAt: null,
          },
        });
      }

      if (args.completion) {
        const completed = await tx.ingestionJob.updateMany({
          where: {
            id: args.completion.id,
            status: IngestionJobStatus.processing,
            leaseToken: args.completion.leaseToken,
          },
          data: {
            status: IngestionJobStatus.completed,
            leaseToken: null,
            resourceId: args.completion.resourceId,
            result: args.completion.result,
            finishedAt: new Date(),
          },
        });
        if (completed.count !== 1) throw new SyncJobCanceledError();
      }
    });
    return { fileAlreadyExisted };
  }

  /**
   * 存储写入早于数据库事务，失败路径需要兜底回收本次写入的对象。
   *
   * 上传/下载的 key 都按内容哈希生成，同一份文件可能被多条资源共用（例如重复上传、
   * 相同快照、带不同下载目录的同步）。删除前必须确认没有任何 resource_files 引用，
   * 否则会连带删掉别的资源的原文件。引用查询本身失败时保守保留——宁可留下孤儿，
   * 也不能误删；残留对象可由一致性检查（ConsistencyService）列出并处理。
   */
  private async deleteStorageKeyIfUnreferenced(storageKey: string): Promise<void> {
    try {
      const references = await this.fileRepo.findStoragePathReferences([storageKey]);
      const resourceIds = references.get(storageKey);
      if (resourceIds && resourceIds.size > 0) {
        this.logger.warn(
          `Keep storage object ${storageKey}: still referenced by ${resourceIds.size} resource(s)`,
        );
        return;
      }
      await this.storage.delete(storageKey);
    } catch (error) {
      this.logger.warn(
        `Failed to clean up unreferenced storage object ${storageKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 记录下载失败到 locator，供健康检查与 UI 溯源，并排下一次补漏时间。
   *
   * 指数退避 30m、1h、2h、4h…（上限 24h）；到 DOWNLOAD_RETRY_MAX_ATTEMPTS 后
   * 不再自动排期，只能由用户手动重试（手动重试会把计数清零）。
   */
  private async markLocatorError(locatorId: string | null, message: string): Promise<void> {
    if (!locatorId) return;
    let attempts: number;
    try {
      // 用数据库自增而不是「先读后写」：后台补漏与手动重试可能同时失败，
      // 读改写会丢掉一次计数，让退避与上限判断失真。
      const updated = await this.prisma.resourceLocator.update({
        where: { id: locatorId },
        data: {
          lastError: message,
          lastCheckedAt: new Date(),
          httpStatus: 0,
          downloadAttempts: { increment: 1 },
        },
        select: { downloadAttempts: true },
      });
      attempts = updated.downloadAttempts;
    } catch (error) {
      // 定位器已被并发删除：错误日志没有落点，忽略
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        return;
      }
      throw error;
    }
    const delay =
      attempts >= DOWNLOAD_RETRY_MAX_ATTEMPTS
        ? null
        : Math.min(DOWNLOAD_RETRY_MAX_DELAY_MS, DOWNLOAD_RETRY_BASE_MS * 2 ** (attempts - 1));
    await this.prisma.resourceLocator.update({
      where: { id: locatorId },
      data: {
        nextDownloadAttemptAt: delay === null ? null : new Date(Date.now() + delay),
      },
    });
  }

  /**
   * 该远端条目是否已成功下载过（台账视角）。
   *
   * 判重不依赖 ResourceLocator：locator 随资源级联删除，而台账不建外键，
   * 因此「彻底删除后再同步」仍能命中，避免重复下载。
   */
  private async isLedgerDownloaded(connectorType: string, externalId: string): Promise<boolean> {
    const entry = await this.prisma.sourceItemLedger.findUnique({
      where: { connectorType_externalId: { connectorType, externalId } },
      select: { state: true },
    });
    return entry?.state === SYNC_LEDGER_DOWNLOADED;
  }

  private async resourceHasOriginalFile(resourceId: string): Promise<boolean> {
    const file = await this.prisma.resourceFile.findUnique({
      where: {
        resourceId_fileRole_variant: { resourceId, fileRole: FileRole.original, variant: '' },
      },
      select: { id: true },
    });
    return file !== null;
  }

  private remoteOriginalFilename(url: string, externalId: string, extension: string): string {
    let name = '';
    try {
      name = path.basename(new URL(url).pathname);
    } catch {
      // Fall back to the stable source-side ID below.
    }
    const normalized = name
      .replace(/\.[a-z0-9]{1,10}$/i, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const fallback = String(externalId)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${normalized || `remote-${fallback || 'file'}`}.${extension}`;
  }

  /**
   * 刷新任务 lease，防止长时间同步（下载大量文件）被 stale 恢复逻辑重置。
   * 通过在 startedAt 上做心跳实现：stale 判定要求 startedAt 早于阈值。
   */
  private async touchJob(jobId: string, leaseToken: string): Promise<void> {
    await this.prisma.ingestionJob.updateMany({
      where: { id: jobId, status: IngestionJobStatus.processing, leaseToken },
      data: { startedAt: new Date() },
    });
  }

  /** 以固定并发执行异步任务（类似 p-limit），单个失败不会中断整体 */
  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await fn(items[index]);
      }
    };
    const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, () =>
      worker(),
    );
    await Promise.all(workers);
    return results;
  }

  /** 归一化单次同步的页数：未配置/非法时为 1，上限 SYNC_MAX_PAGES_CAP */
  private clampSyncMaxPages(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(Math.floor(parsed), SYNC_MAX_PAGES_CAP);
  }

  /** 解析同步下载并发：来源 maxConcurrency 未配置/非法时回退到模块级默认，并设上限。
   *  注意 maxConcurrency 的历史 DB 默认值是 1（死字段时代），
   *  因此把 < 2 视为"未配置"，使用内置默认并发，避免存量来源从并发 4 悄悄掉到 1。 */
  private resolveDownloadConcurrency(value: number | null | undefined): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 2) {
      return Math.min(Math.floor(value), SYNC_DOWNLOAD_CONCURRENCY_CAP);
    }
    return SYNC_DOWNLOAD_CONCURRENCY;
  }

  private resolveDownloadInterval(source: {
    rateLimitPerMinute: number | null | undefined;
    downloadIntervalMs?: number | null;
  }): number {
    const rateLimit = Number.isFinite(source.rateLimitPerMinute)
      ? Math.max(1, Math.floor(source.rateLimitPerMinute!))
      : 1000;
    const rateLimitIntervalMs = Math.ceil(60_000 / rateLimit);
    const configuredIntervalMs = Number.isFinite(source.downloadIntervalMs)
      ? Math.max(0, Math.min(60_000, Math.floor(source.downloadIntervalMs!)))
      : 0;
    return Math.max(rateLimitIntervalMs, configuredIntervalMs);
  }

  /**
   * 下载任务心跳间隔：不超过 5s，同时不超过 stale 超时的 1/3。
   * stale 配置非法或缺失时回退默认 60s，保证心跳不会算成 NaN 而失效。
   */
  private resolveJobHeartbeatIntervalMs(): number {
    const configured = this.config.get<number>('ingestion.staleJobTimeoutMs');
    const staleTimeoutMs =
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? configured
        : 60_000;
    return Math.max(1_000, Math.min(JOB_HEARTBEAT_INTERVAL_MS, Math.floor(staleTimeoutMs / 3)));
  }

  /**
   * 占用来源速率槽。
   *
   * 返回 0 表示已占用、可以立即下载；返回 >0 表示还需等待的毫秒数，
   * 此时不会占用槽位。自动同步与手动/批量镜像共用同一份预算。
   * 来源限速配置变化时只更新间隔，保留已有等待窗口，避免交替放行造成突发。
   */
  private reserveSourceDownloadSlot(source: {
    id: string;
    rateLimitPerMinute: number | null;
    downloadIntervalMs?: number | null;
  }): number {
    const intervalMs = this.resolveDownloadInterval(source);
    const now = Date.now();
    const existing = this.sourceDownloadSlots.get(source.id);
    if (!existing) {
      this.sourceDownloadSlots.set(source.id, {
        intervalMs,
        nextAvailableAt: now + intervalMs,
      });
      return 0;
    }
    if (existing.intervalMs !== intervalMs) {
      // 同步任务持有启动时的来源快照，手动任务每次都重新读取。配置变更期间两边
      // 的 interval 会持续不一致；如果每次都重置并立即放行，会交替产生突发下载。
      // 这里只更新间隔，保留已有的等待窗口。
      existing.intervalMs = intervalMs;
    }
    if (existing.nextAvailableAt <= now) {
      existing.nextAvailableAt = now + intervalMs;
      return 0;
    }
    return existing.nextAvailableAt - now;
  }

  /**
   * 阻塞等待来源速率槽（自动同步路径使用）。
   * 手动下载任务不能用它等待，否则会卡住整条摄入队列。
   */
  private async waitForSourceDownloadSlot(
    source: {
      id: string;
      rateLimitPerMinute: number | null;
      downloadIntervalMs?: number | null;
    },
    assertActive?: () => Promise<void>,
  ): Promise<void> {
    for (;;) {
      await assertActive?.();
      // 有手动任务刚被限速延后时，让出接下来的槽位。手动任务由调度器
      // 每轮重新认领，只有一次抢占机会；同步等待者每 250ms 轮询，若不让出
      // 会一直把槽位抢走，导致“下载到本地”长时间停在 pending。
      const priorityUntil = this.manualDownloadPriorityUntil.get(source.id);
      if (priorityUntil !== undefined) {
        if (priorityUntil > Date.now()) {
          await this.sleep(250);
          continue;
        }
        this.manualDownloadPriorityUntil.delete(source.id);
      }
      const waitMs = this.reserveSourceDownloadSlot(source);
      if (waitMs === 0) return;
      await this.sleep(Math.min(waitMs, 250));
    }
  }

  private async assertSyncJobActive(id: string, leaseToken: string): Promise<void> {
    if (this.jobRepo.isProcessing && !(await this.jobRepo.isProcessing(id, leaseToken))) {
      throw new SyncJobCanceledError();
    }
  }

  /** 摄入任务轮询间隔（ms），与调度器配置保持一致，用于计算同步退避 */
  private pollIntervalMs(): number {
    return this.config.get<number>('ingestion.pollIntervalMs') ?? 3000;
  }

  /**
   * 按 sourceId + externalId 去重后创建或跳过远端资源
   *
   * - 若 ResourceLocator 已存在该 sourceId+externalId → 返回 { isNew: false }（幂等）
   * - 若同一 identityUrl 已存在于其它来源（同一张图被两个来源同步）→ 复用该资源，不重复建
   * - 否则创建 Resource(metadata_only) + ResourceLocator[] + ResourceProvenance
   */
  private async upsertRemoteResource(
    remote: import('./connectors/resource-connector.interface').RemoteResource,
    source: { id: string; name: string; downloadCategoryId?: string | null },
    ingestionJobId: string,
    connectorType: string,
  ): Promise<{ resourceId: string; downloadLocatorId: string | null; isNew: boolean } | null> {
    // 连接器解析出的远端预览图。feed 的 <img src> / media:thumbnail 可能是相对地址，
    // 直接入库会让卡片和详情页拿到打不开的链接，这里统一转成绝对 HTTP(S) 地址。
    const previewUrl = this.normalizeRemotePreviewUrl(remote);
    // 预览与下载是同一地址（如 Civitai）时无需单独记录，列表/详情的回退逻辑本就能用。
    // 下载地址只做比较，不改写下载定位器里保存的原始地址。
    const distinctPreviewUrl =
      previewUrl &&
      previewUrl !==
        (this.normalizeRemoteAssetUrl(remote.url, [remote.canonicalUrl, remote.url]) ?? remote.url)
        ? previewUrl
        : null;
    // Check for existing locator with this externalId under this source
    const existingLocator = await this.prisma.resourceLocator.findFirst({
      where: {
        sourceId: source.id,
        externalId: remote.externalId,
      },
      select: { resourceId: true, id: true },
    });

    if (existingLocator) {
      // Resource already exists for this externalId — return it so caller can decide on download retry
      return {
        resourceId: existingLocator.resourceId,
        downloadLocatorId: existingLocator.id,
        isNew: false,
      };
    }

    // 全局去重：同一 identityUrl 已存在于其它来源（同一远端内容被多个来源同步）→ 复用该资源。
    // identityUrl 有唯一约束，因此冲突只可能来自其它来源。
    const identityUrl = `${connectorType}://image/${remote.externalId}`;
    const globalLocator = await this.prisma.resourceLocator.findFirst({
      where: { identityUrl },
      select: { resourceId: true, id: true },
    });
    if (globalLocator) {
      return {
        resourceId: globalLocator.resourceId,
        downloadLocatorId: globalLocator.id,
        isNew: false,
      };
    }

    // Create new resource with metadata_only acquisition mode
    // Derive extension from URL for more accurate file type representation
    let extension = 'bin';
    try {
      const urlPath = new URL(remote.url).pathname;
      const ext = urlPath.split('.').pop()?.toLowerCase();
      if (ext && /^[a-z0-9]{1,10}$/.test(ext)) extension = ext;
    } catch {
      // Fall back to MIME type
      if (remote.mimeType) extension = remote.mimeType.split('/')[1] ?? 'bin';
    }

    try {
      const resource = await this.prisma.resource.create({
        data: {
          title: remote.title,
          description: remote.description,
          originalFilename: this.remoteOriginalFilename(remote.url, remote.externalId, extension),
          resourceType: remote.resourceType,
          mimeType: remote.mimeType ?? 'application/octet-stream',
          extension,
          sizeBytes: BigInt(0), // metadata_only: no file downloaded
          source: remote.publisher,
          author: remote.authorName,
          acquisitionMode: AcquisitionMode.metadata_only,
          sourceRecord: { connect: { id: source.id } },
          // 来源配置了下载文件夹时，新导入的资源直接归入该文件夹
          category: source.downloadCategoryId
            ? { connect: { id: source.downloadCategoryId } }
            : undefined,
          processingStatus: ProcessingStatus.completed, // metadata is already captured
          width: remote.width,
          height: remote.height,
          externalCreatedAt: remote.externalCreatedAt,
          locators: {
            create: [
              {
                sourceId: source.id,
                locatorType: LocatorType.download,
                url: remote.url,
                canonicalUrl: remote.canonicalUrl,
                identityUrl: `${connectorType}://image/${remote.externalId}`,
                externalId: remote.externalId,
                isPrimary: true,
                contentType: remote.mimeType,
                lastCheckedAt: new Date(),
              },
              // 连接器解析出的远端预览图单独落一条 preview 定位器：列表卡片与详情页
              // 据此展示缩略图。预览地址与下载地址相同时（如 Civitai）无需重复记录，
              // 两处的回退逻辑本就会使用下载地址。不写 contentType，交给健康检查探测。
              ...(distinctPreviewUrl
                ? [
                    {
                      sourceId: source.id,
                      locatorType: LocatorType.preview,
                      url: distinctPreviewUrl,
                      isPrimary: false,
                    },
                  ]
                : []),
              ...(remote.additionalLocators ?? []).map((loc) => ({
                sourceId: source.id,
                locatorType: loc.locatorType,
                url: loc.url,
                isPrimary: false,
              })),
            ],
          },
          provenance: {
            create: {
              sourceId: source.id,
              ingestionJobId,
              connectorType: connectorType,
              connectorVersion: '0.1',
              originalUrl: remote.url,
              publisher: remote.publisher,
              authorName: remote.authorName,
              authorUrl: remote.authorUrl,
              rawMetadata: JSON.stringify(remote.rawMetadata),
            },
          },
        },
        include: { locators: true },
      });

      const downloadLocator = resource.locators.find(
        (loc) => loc.locatorType === LocatorType.download,
      );
      return {
        resourceId: resource.id,
        downloadLocatorId: downloadLocator?.id ?? null,
        isNew: true,
      };
    } catch (error) {
      // Handle race condition: another concurrent sync already created this locator.
      // P2002 可能来自 sourceId+externalId 唯一约束，或全局 identityUrl 唯一约束（其它来源已同步同一内容）。
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.resourceLocator.findFirst({
          where: {
            OR: [
              { sourceId: source.id, externalId: remote.externalId },
              { identityUrl: `${connectorType}://image/${remote.externalId}` },
            ],
          },
          select: { resourceId: true, id: true },
        });
        if (concurrent) {
          return {
            resourceId: concurrent.resourceId,
            downloadLocatorId: concurrent.id,
            isNew: false,
          };
        }
      }
      throw error;
    }
  }

  /**
   * 把连接器给出的 URL 转成可安全入库的绝对 HTTP(S) 地址
   *
   * feed 的 `<img src>` / media:thumbnail 可能是相对地址或协议相对地址（`//cdn/...`），
   * 甚至 data: URI；原样写进 locator 会让列表卡片和详情页拿到打不开的链接。
   * 无法解析成合法 HTTP(S) 地址时返回 null，按「没有预览」处理。
   */
  private normalizeRemoteAssetUrl(
    rawUrl: string | null | undefined,
    baseUrls: Array<string | null | undefined>,
  ): string | null {
    const value = rawUrl?.trim();
    if (!value) return null;
    // 绝对地址与任何基准无关；相对地址按顺序尝试条目页面、下载地址。
    // 基准本身也可能是相对串（少见），解析失败就换下一个，最后再按纯绝对地址解析。
    for (const baseUrl of [...baseUrls, undefined]) {
      try {
        const resolved = new URL(value, baseUrl ?? undefined).toString();
        return this.safeUrl.normalize(resolved).toString();
      } catch {
        // 换下一个基准
      }
    }
    return null;
  }

  /** 连接器的预览地址优先按条目页面（canonicalUrl）解析相对路径 */
  private normalizeRemotePreviewUrl(
    remote: import('./connectors/resource-connector.interface').RemoteResource,
  ): string | null {
    return this.normalizeRemoteAssetUrl(remote.previewUrl, [remote.canonicalUrl, remote.url]);
  }

  /**
   * 给同步前就已存在的资源补写远端预览定位器
   *
   * 旧版本同步把连接器解析出的 previewUrl 丢掉了，只保存下载/页面定位器，
   * 导致列表卡片和详情页都没有缩略图。新资源在 upsertRemoteResource 创建时
   * 已直接带上 preview 定位器；这里负责历史资源，且不覆盖已有的 preview。
   */
  private async ensureRemotePreviewLocator(
    remote: import('./connectors/resource-connector.interface').RemoteResource,
    sourceId: string,
    connectorType: string,
  ): Promise<void> {
    const previewUrl = this.normalizeRemotePreviewUrl(remote);
    const downloadUrl =
      this.normalizeRemoteAssetUrl(remote.url, [remote.canonicalUrl, remote.url]) ?? remote.url;
    // 预览地址与下载地址相同（如 Civitai）时，列表/详情的回退逻辑本就能用
    if (!previewUrl || previewUrl === downloadUrl) return;

    try {
      const downloadLocator = await this.prisma.resourceLocator.findFirst({
        where: {
          OR: [
            { sourceId, externalId: remote.externalId },
            // 同一内容可能已由其它来源同步过（identityUrl 全局去重），一并补写
            { identityUrl: `${connectorType}://image/${remote.externalId}` },
          ],
        },
        select: {
          resourceId: true,
          resource: {
            select: {
              locators: {
                where: { locatorType: LocatorType.preview },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      });
      // 新资源：创建时已经带上 preview 定位器
      if (!downloadLocator) return;
      if (downloadLocator.resource?.locators.length) return;

      await this.prisma.resourceLocator.create({
        data: {
          resourceId: downloadLocator.resourceId,
          sourceId,
          locatorType: LocatorType.preview,
          url: previewUrl,
          isPrimary: false,
        },
      });
    } catch (error) {
      // 缩略图只是展示优化，补写失败不应影响该条目的同步与下载
      this.logger.warn(
        `Failed to backfill preview locator for ${remote.externalId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 批量预取本页哪些远端条目已经有 preview 定位器。
   *
   * 与 ensureRemotePreviewLocator 的定位规则保持一致（来源 + externalId，或
   * 跨来源的 identityUrl 去重）。一次 IN 查询替代整页 N 次 findFirst，已补齐
   * 的条目在后续同步中完全不再产生查询。
   */
  private async findExternalIdsWithPreviewLocator(
    remotes: Array<{ externalId: string }>,
    sourceId: string,
    connectorType: string,
  ): Promise<Set<string>> {
    if (remotes.length === 0) return new Set();
    const externalIds = [...new Set(remotes.map((remote) => remote.externalId))];
    const ready = new Set<string>();
    // 分块：SQLite 的绑定变量上限约 999，两个 IN 列表会翻倍。任何一块失败都
    // 整体退回逐条检查，宁可多查也不能漏补。
    const CHUNK_SIZE = 200;
    try {
      for (let offset = 0; offset < externalIds.length; offset += CHUNK_SIZE) {
        const chunk = externalIds.slice(offset, offset + CHUNK_SIZE);
        const externalIdByIdentity = new Map(
          chunk.map((externalId) => [`${connectorType}://image/${externalId}`, externalId]),
        );
        const rows = await this.prisma.resourceLocator.findMany({
          where: {
            OR: [
              { sourceId, externalId: { in: chunk } },
              { identityUrl: { in: [...externalIdByIdentity.keys()] } },
            ],
          },
          select: {
            externalId: true,
            identityUrl: true,
            resource: {
              select: {
                locators: {
                  where: { locatorType: LocatorType.preview },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        });
        for (const row of rows) {
          if (!row.resource?.locators.length) continue;
          const externalId =
            row.externalId ??
            (row.identityUrl ? externalIdByIdentity.get(row.identityUrl) : undefined);
          if (externalId) ready.add(externalId);
        }
      }
      return ready;
    } catch (error) {
      // 预取只是优化：失败就退化为逐条检查，不能影响同步本身
      this.logger.warn(
        `Failed to prefetch preview locators for source ${sourceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Set();
    }
  }

  /** 按 sourceType 路由到对应的连接器 */
  private getConnectorForSourceType(sourceType: string): ResourceConnector | null {
    if (sourceType === 'civitai') return this.civitaiConnector;
    if (sourceType === 'github') return this.githubConnector;
    if (sourceType === 'rss') return this.feedConnector;
    return null;
  }

  private parseSyncSourceRequest(serialized: string): SyncSourceRequest {
    const request: unknown = JSON.parse(serialized);
    if (
      !request ||
      typeof request !== 'object' ||
      typeof (request as { sourceId?: unknown }).sourceId !== 'string'
    ) {
      throw new BadRequestException('Invalid sync source request');
    }
    return request as SyncSourceRequest;
  }
}
