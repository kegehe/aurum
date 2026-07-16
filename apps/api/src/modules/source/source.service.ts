import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SourceRepository } from './repositories/source.repository';
import { CreateSourceDto } from './dto/create-source.dto';
import { UpdateSourceDto } from './dto/update-source.dto';
import { QuerySourcesDto } from './dto/query-sources.dto';
import { AcquisitionMode } from '../../common/constants/enums';

/** 合法的 allowedModes 值集合 */
const VALID_MODES = new Set(Object.values(AcquisitionMode));

/**
 * 来源配置应用服务
 * 职责：来源 CRUD、allowedModes 校验、slug 唯一性
 */
@Injectable()
export class SourceService {
  constructor(private readonly sourceRepo: SourceRepository) {}

  /** 分页查询来源列表 */
  async listSources(query: QuerySourcesDto) {
    const result = await this.sourceRepo.findMany({
      enabled: query.enabled,
      sourceType: query.sourceType,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });
    return { ...result, totalPages: Math.ceil(result.total / result.pageSize) };
  }

  /** 获取单个来源 */
  async getSource(id: string) {
    const source = await this.sourceRepo.findById(id);
    if (!source) throw new NotFoundException(`Source ${id} not found`);
    return source;
  }

  /** 创建来源配置 */
  async createSource(dto: CreateSourceDto) {
    // 校验 slug 唯一
    const existing = await this.sourceRepo.findBySlug(dto.slug);
    if (existing) {
      throw new ConflictException(`Source slug "${dto.slug}" already exists`);
    }

    // 校验 allowedModes 格式（非空时校验，空字符串也视为无效）
    if (dto.allowedModes !== undefined) {
      this.validateAllowedModes(dto.allowedModes);
    }

    try {
      return await this.sourceRepo.create({
        name: dto.name,
        slug: dto.slug,
        baseUrl: dto.baseUrl,
        sourceType: dto.sourceType,
        enabled: dto.enabled ?? true,
        allowedModes: dto.allowedModes ?? 'link_only,metadata_only',
        termsUrl: dto.termsUrl,
        robotsUrl: dto.robotsUrl,
        defaultLicenseId: dto.defaultLicenseId,
        rateLimitPerMinute: dto.rateLimitPerMinute ?? 30,
        maxConcurrency: dto.maxConcurrency ?? 1,
        requiresReview: dto.requiresReview ?? false,
        config: dto.config,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Source slug "${dto.slug}" already exists`);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new BadRequestException('Referenced defaultLicenseId does not exist');
      }
      throw error;
    }
  }

  /** 更新来源配置 */
  async updateSource(id: string, dto: UpdateSourceDto) {
    const existing = await this.sourceRepo.findById(id);
    if (!existing) throw new NotFoundException(`Source ${id} not found`);

    // 如果更新 slug，校验唯一性
    if (dto.slug && dto.slug !== existing.slug) {
      const conflict = await this.sourceRepo.findBySlug(dto.slug);
      if (conflict) {
        throw new ConflictException(`Source slug "${dto.slug}" already exists`);
      }
    }

    // 如果更新 allowedModes，校验格式（空字符串也视为无效）
    if (dto.allowedModes !== undefined) {
      this.validateAllowedModes(dto.allowedModes);
    }

    try {
      return await this.sourceRepo.update(id, {
        name: dto.name,
        slug: dto.slug,
        // nullable 字段：DTO 中 undefined = 不更新，null = 清除，string = 更新
        baseUrl: dto.baseUrl === undefined ? undefined : (dto.baseUrl as string | null),
        sourceType: dto.sourceType,
        enabled: dto.enabled,
        allowedModes: dto.allowedModes,
        termsUrl: dto.termsUrl === undefined ? undefined : (dto.termsUrl as string | null),
        robotsUrl: dto.robotsUrl === undefined ? undefined : (dto.robotsUrl as string | null),
        defaultLicenseId: dto.defaultLicenseId === undefined ? undefined : (dto.defaultLicenseId as string | null),
        rateLimitPerMinute: dto.rateLimitPerMinute,
        maxConcurrency: dto.maxConcurrency,
        requiresReview: dto.requiresReview,
        config: dto.config === undefined ? undefined : (dto.config as string | null),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Source slug "${dto.slug}" already exists`);
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new BadRequestException('Referenced defaultLicenseId does not exist');
      }
      throw error;
    }
  }

  /** 删除来源（仅允许删除无关联资源的来源） */
  async deleteSource(id: string) {
    const result = await this.sourceRepo.delete(id);
    if (!result.deleted) {
      if (result.reason === 'not_found') {
        throw new NotFoundException(`Source ${id} not found`);
      }
      if (result.reason === 'has_resources') {
        throw new BadRequestException(
          'Cannot delete a source that has associated resources',
        );
      }
      if (result.reason === 'has_ingestion_jobs') {
        throw new BadRequestException(
          'Cannot delete a source that has associated ingestion jobs',
        );
      }
      if (result.reason === 'has_locators') {
        throw new BadRequestException(
          'Cannot delete a source that has associated resource locators',
        );
      }
      if (result.reason === 'has_provenance') {
        throw new BadRequestException(
          'Cannot delete a source that has associated provenance records',
        );
      }
    }
    return { id, deleted: true };
  }

  /** 校验 allowedModes 逗号分隔值都是合法的 AcquisitionMode */
  private validateAllowedModes(allowedModes: string): void {
    const modes = allowedModes.split(',').map((m) => m.trim());
    const invalid = modes.filter((m) => !VALID_MODES.has(m as AcquisitionMode));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid acquisition modes: ${invalid.join(', ')}. Valid modes: ${Object.values(AcquisitionMode).join(', ')}`,
      );
    }
  }
}
