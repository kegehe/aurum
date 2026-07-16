import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IngestionJob } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  AcquisitionMode,
  IngestionJobStatus,
  IngestionJobType,
  LicenseStatus,
  LocatorType,
  ProcessingStatus,
  ResourceType,
} from '../../common/constants/enums';
import { SafeUrlService } from '../../common/security/safe-url.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResourceRepository } from '../resource/repositories/resource.repository';
import { SourceRepository } from '../source/repositories/source.repository';
import { LinkMetadataConnector } from './connectors/link-metadata.connector';
import { LocatorHealthChecker } from './connectors/locator-health-checker';
import { CreateLinkImportDto } from './dto/create-link-import.dto';
import { QueryIngestionJobsDto } from './dto/query-ingestion-jobs.dto';
import { IngestionJobRepository } from './repositories/ingestion-job.repository';

interface LinkImportRequest {
  url: string;
  sourceId?: string;
  categoryId?: string;
  title?: string;
  tagIds?: string[];
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobRepo: IngestionJobRepository,
    private readonly sourceRepo: SourceRepository,
    private readonly resourceRepo: ResourceRepository,
    private readonly safeUrl: SafeUrlService,
    private readonly linkMetadataConnector: LinkMetadataConnector,
    private readonly locatorHealthChecker: LocatorHealthChecker,
  ) {}

  async createLinkImport(dto: CreateLinkImportDto) {
    const normalizedUrl = this.safeUrl.normalize(dto.url).toString();
    if (dto.sourceId) await this.assertLinkImportAllowed(dto.sourceId, normalizedUrl);
    if (dto.categoryId) await this.assertCategoryExists(dto.categoryId);
    const tagIds = dto.tagIds ? [...new Set(dto.tagIds)].sort() : [];
    if (tagIds.length) await this.assertTagsExist(tagIds);

    const request: LinkImportRequest = {
      url: normalizedUrl,
      sourceId: dto.sourceId,
      categoryId: dto.categoryId,
      title: dto.title?.trim() || undefined,
      tagIds: tagIds.length ? tagIds : undefined,
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

  async runNextJob(): Promise<boolean> {
    const job = await this.jobRepo.claimNext();
    if (!job) return false;
    if (!job.leaseToken) {
      this.logger.error(`Claimed ingestion job ${job.id} without a lease token`);
      return true;
    }
    const leaseToken = job.leaseToken;
    try {
      if (job.jobType !== IngestionJobType.import_url && job.jobType !== IngestionJobType.check_locator) {
        throw new BadRequestException(`Unsupported ingestion job type: ${job.jobType}`);
      }
      if (job.jobType === IngestionJobType.check_locator) {
        await this.runLocatorCheck(job, leaseToken);
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
      if (completed) this.logger.log(`Imported link resource ${resourceId} from ${metadata.canonicalUrl}`);
      else this.logger.warn(`Ingestion job ${job.id} lost its lease before completion`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof BadRequestException ? 'invalid_remote_resource' : 'import_failed';
      const failed = await this.jobRepo.fail(job.id, leaseToken, errorCode, message);
      if (failed) this.logger.warn(`Ingestion job ${job.id} failed: ${message}`);
      else this.logger.warn(`Ingestion job ${job.id} lost its lease before failure: ${message}`);
    }
    return true;
  }

  async resetStaleJobs(staleJobTimeoutMs: number) {
    return this.jobRepo.resetStaleProcessing(new Date(Date.now() - staleJobTimeoutMs));
  }

  /**
   * 调度过期 locator 的健康检查任务
   *
   * 根据指数退避策略计算阈值：
   * - 从未检查 → 立即
   * - 上次成功 (httpStatus 2xx) → 7 天后重查
   * - 上次失败 1 次 → 1 天后
   * - 上次失败 2 次 → 3 天后
   * - 上次失败 3+ 次 → 7 天后
   */
  async scheduleLocatorHealthChecks(batchSize = 10): Promise<number> {
    const staleBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 默认 7 天
    const locators = await this.jobRepo.findLocatorsNeedingCheck(staleBefore, batchSize);
    let created = 0;
    for (const locator of locators) {
      // 根据上次检查结果调整阈值
      if (locator.lastCheckedAt) {
        const isFailure = (locator.httpStatus ?? 0) >= 400 || locator.lastError !== null;
        if (!isFailure) continue; // 成功的 7 天阈值已由 staleBefore 覆盖
        // 失败的应该更频繁检查，但 findLocatorsNeedingCheck 已经按 7 天阈值选出来了
        // 这里不额外过滤，让所有 stale 的都被检查
      }
      const job = await this.enqueueLocatorCheck(locator.id, locator.url, locator.sourceId ?? undefined);
      if (job) created++;
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
  async assertDownloadAllowed(sourceId: string | null | undefined, acquisitionMode: string): Promise<void> {
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
    if (!allowedModes.includes(acquisitionMode)) {
      throw new BadRequestException(`Source does not allow ${acquisitionMode} mode`);
    }
    if (source.requiresReview) {
      throw new BadRequestException('Source requires manual review before download');
    }
  }

  private async runLocatorCheck(job: IngestionJob, leaseToken: string): Promise<void> {
    const request = this.parseLocatorCheckRequest(job.request);
    const result = await this.locatorHealthChecker.check(request.url);
    const now = new Date();

    await this.prisma.resourceLocator.update({
      where: { id: request.locatorId },
      data: {
        httpStatus: result.httpStatus || null,
        contentType: result.contentType,
        contentLength: result.contentLength,
        etag: result.etag,
        lastModified: result.lastModified,
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
    if (completed) this.logger.log(`Locator health check completed: ${request.locatorId} → HTTP ${result.httpStatus || 'error'}`);
    else this.logger.warn(`Ingestion job ${job.id} lost its lease before completion`);
  }

  private parseLinkImportRequest(serialized: string): LinkImportRequest {
    const request: unknown = JSON.parse(serialized);
    if (!request || typeof request !== 'object' || typeof (request as { url?: unknown }).url !== 'string') {
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
        basePath === '/' ||
        targetPath === basePath ||
        targetPath.startsWith(`${basePath}/`);
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
        tags: request.tagIds?.length
          ? { create: request.tagIds.map((tagId) => ({ tag: { connect: { id: tagId } } })) }
          : undefined,
        acquisitionMode: AcquisitionMode.link_only,
        sourceRecord: source ? { connect: { id: source.id } } : undefined,
        licenseStatus: LicenseStatus.unknown,
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
              ? [{ sourceId: source?.id, locatorType: LocatorType.preview, url: metadata.previewUrl }]
              : []),
            ...(metadata.faviconUrl
              ? [{ sourceId: source?.id, locatorType: LocatorType.favicon, url: metadata.faviconUrl }]
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
    for (const tagId of request.tagIds ?? []) {
      try {
        await this.prisma.resourceTag.create({ data: { resourceId, tagId } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    return resourceId;
  }

  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException(`Category ${categoryId} not found`);
  }

  private async assertTagsExist(tagIds: string[]): Promise<void> {
    const tags = await this.prisma.tag.findMany({
      where: { id: { in: tagIds } },
      select: { id: true },
    });
    if (tags.length !== tagIds.length) throw new NotFoundException('One or more tags were not found');
  }
}
