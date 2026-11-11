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
} from '../../common/constants/enums';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { JOB_SCHEDULER, IJobScheduler } from '../processing/interfaces/job-scheduler.interface';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRepository } from '../resource/repositories/resource.repository';
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

/** 来源同步时并发下载的文件数 */
const SYNC_DOWNLOAD_CONCURRENCY = 4;
/** 同步下载并发的上限（防止来源 maxConcurrency 误配导致打爆远程服务） */
const SYNC_DOWNLOAD_CONCURRENCY_CAP = 20;
/** 单次来源同步最多连续抓取的页数（上限，防止误配导致大量下载） */
const SYNC_MAX_PAGES_CAP = 50;
/** 单个远端文件的整体下载超时（DirectDownloadConnector 内部另有读写超时） */
const DOWNLOAD_TOTAL_TIMEOUT_MS = 180_000;
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
          await this.jobRepo.release(job.id, leaseToken, backoffMs);
          this.logger.debug(
            `Sync job ${job.id} deferred for ${backoffMs}ms (another sync is running)`,
          );
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
    if (resource.deletedAt) throw new BadRequestException('Cannot download a deleted resource');
    if (resource.files.length) {
      throw new BadRequestException('Resource already has a local original file');
    }
    const locator = resource.locators.find((item) => item.locatorType === LocatorType.download);
    if (!locator) throw new BadRequestException('Resource has no downloadable source URL');

    // Clicking "download locally" is the explicit manual review required by
    // metadata-only sources. The source's mirror_file policy is still enforced.
    await this.assertDownloadAllowed(resource.sourceId, AcquisitionMode.mirror_file, true);
    return this.enqueueDownloadJob(resourceId, resource.sourceId);
  }

  /**
   * 后台补漏：重排到期（nextDownloadAttemptAt 已过）的失败下载。
   *
   * 只处理无需人工审核、来源仍启用的资源；同一资源已有排队任务时
   * 由幂等键复用，不会重复入队。返回本轮入队数量。
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
        sourceRecord: { enabled: true, requiresReview: false },
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
   * 仍逐条走来源策略门禁：不允许镜像下载的来源记为 skipped，不会建任务。
   */
  async retryFailedDownloads(params: { sourceId?: string; limit?: number } = {}): Promise<{
    queued: number;
    skipped: number;
  }> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const candidates = await this.prisma.resource.findMany({
      where: {
        acquisitionMode: AcquisitionMode.metadata_only,
        deletedAt: null,
        files: { none: { fileRole: FileRole.original, variant: '' } },
        locators: {
          some: { locatorType: LocatorType.download, lastError: { not: null } },
        },
        sourceId: params.sourceId ?? { not: null },
      },
      select: { id: true, sourceId: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let queued = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      try {
        await this.assertDownloadAllowed(candidate.sourceId, AcquisitionMode.mirror_file, true);
        await this.enqueueDownloadJob(candidate.id, candidate.sourceId);
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
  private async enqueueDownloadJob(resourceId: string, sourceId: string | null) {
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
    // 旧快照对象与新的 hash 不同才会残留，best-effort 清理
    if (existing && existing.storagePath !== storageKey) {
      await this.storage.delete(existing.storagePath).catch(() => undefined);
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
    if (source.baseUrl) {
      const baseUrl = this.safeUrl.normalize(source.baseUrl);
      const target = this.safeUrl.normalize(targetUrl);
      const normalizePath = (pathname: string) =>
        pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
      const basePath = normalizePath(baseUrl.pathname);
      const targetPath = normalizePath(target.pathname);
      const pathMatches =
        basePath === '/' || targetPath === basePath || targetPath.startsWith(`${basePath}/`);
      if (target.origin !== baseUrl.origin || !pathMatches) {
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
    const downloadIntervalMs = this.resolveDownloadInterval({
      rateLimitPerMinute: source.rateLimitPerMinute,
      downloadIntervalMs: (source as { downloadIntervalMs?: number }).downloadIntervalMs,
    });
    const waitForDownloadSlot = this.createDownloadThrottle(downloadIntervalMs, () =>
      this.assertSyncJobActive(job.id, leaseToken),
    );

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
    },
    ingestionJobId: string,
    leaseToken: string,
    connectorType: string,
    waitForDownloadSlot: () => Promise<void>,
  ): Promise<'downloaded' | 'skipped' | 'failed'> {
    try {
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
  ): Promise<'downloaded' | 'failed'> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TOTAL_TIMEOUT_MS);
    let canceled = false;
    const assertJobActive = async () => {
      if (jobControl) await this.assertSyncJobActive(jobControl.id, jobControl.leaseToken);
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

          // 事务：更新资源元数据 + 建原文件记录 + 更新 locator + 按 sha256 查重
          await this.commitDownloadedFile({
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
            completion: jobControl?.completeOnCommit
              ? {
                  id: jobControl.id,
                  leaseToken: jobControl.leaseToken,
                  resourceId,
                  result: JSON.stringify({ status: 'downloaded' }),
                }
              : undefined,
          });

          // 入队元数据检测（图片会链式生成缩略图），与上传流程一致
          await this.scheduler.enqueue(JobType.detect_metadata, resourceId).catch((error) => {
            this.logger.warn(
              `Failed to enqueue metadata detection for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });

          return 'downloaded';
        } catch (error) {
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

  /** 事务提交下载结果：更新资源 + 建原文件 + 更新 locator + 按 sha256 查重 */
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
    completion?: {
      id: string;
      leaseToken: string;
      resourceId: string;
      result: string;
    };
  }): Promise<void> {
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
            return;
          }
          throw error;
        });

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
  }

  /**
   * 记录下载失败到 locator，供健康检查与 UI 溯源，并排下一次补漏时间。
   *
   * 指数退避 30m、1h、2h、4h…（上限 24h）；到 DOWNLOAD_RETRY_MAX_ATTEMPTS 后
   * 不再自动排期，只能由用户手动重试（手动重试会把计数清零）。
   */
  private async markLocatorError(locatorId: string | null, message: string): Promise<void> {
    if (!locatorId) return;
    const locator = await this.prisma.resourceLocator.findUnique({
      where: { id: locatorId },
      select: { downloadAttempts: true },
    });
    if (!locator) return;
    const attempts = locator.downloadAttempts + 1;
    const delay =
      attempts >= DOWNLOAD_RETRY_MAX_ATTEMPTS
        ? null
        : Math.min(DOWNLOAD_RETRY_MAX_DELAY_MS, DOWNLOAD_RETRY_BASE_MS * 2 ** (attempts - 1));
    await this.prisma.resourceLocator.update({
      where: { id: locatorId },
      data: {
        lastError: message,
        lastCheckedAt: new Date(),
        httpStatus: 0,
        downloadAttempts: attempts,
        nextDownloadAttemptAt: delay === null ? null : new Date(Date.now() + delay),
      },
    });
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

  private createDownloadThrottle(
    intervalMs: number,
    assertActive?: () => Promise<void>,
  ): () => Promise<void> {
    let nextAvailableAt = 0;
    let queue = Promise.resolve();

    return async () => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        while (true) {
          await assertActive?.();
          const waitMs = Math.max(0, nextAvailableAt - Date.now());
          if (waitMs === 0) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 250)));
        }
        await assertActive?.();
        nextAvailableAt = Date.now() + intervalMs;
      } finally {
        release();
      }
    };
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
    source: { id: string; name: string },
    ingestionJobId: string,
    connectorType: string,
  ): Promise<{ resourceId: string; downloadLocatorId: string | null; isNew: boolean } | null> {
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
