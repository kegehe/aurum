import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Prisma } from '@prisma/client';
import { SourceRepository } from './repositories/source.repository';
import { CreateSourceDto } from './dto/create-source.dto';
import { UpdateSourceDto } from './dto/update-source.dto';
import { QuerySourcesDto } from './dto/query-sources.dto';
import { AcquisitionMode } from '../../common/constants/enums';

/** 合法的 allowedModes 值集合 */
const VALID_MODES = new Set(Object.values(AcquisitionMode));

/** 存储根目录下的系统角色目录（非用户自定义来源目录），目录枚举时排除 */
const SYSTEM_STORAGE_DIRS = new Set([
  'originals',
  'thumbnails',
  'previews',
  'extracted-text',
  'transcodes',
  'temp',
]);

/**
 * 来源配置应用服务
 * 职责：来源 CRUD、allowedModes 校验、slug 唯一性
 */
@Injectable()
export class SourceService {
  constructor(
    private readonly sourceRepo: SourceRepository,
    private readonly config: ConfigService,
  ) {}

  /**
   * 获取可选的下载目录列表（供前端“选择目录”）。
   * 并集 = 已有来源配置的 downloadDirectory（去重） ∪ 存储根目录下已存在的一级自定义目录。
   */
  async listDownloadDirectories(): Promise<string[]> {
    const fromDb = (await this.sourceRepo.findDownloadDirectories())
      .map((row) => row.downloadDirectory as string)
      .filter(Boolean);
    const set = new Set(fromDb);

    // 存储根目录下已存在的一级目录（排除系统角色目录）也可直接复用
    const root = path.resolve(this.config.get<string>('storage.root') || './storage');
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SYSTEM_STORAGE_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
        set.add(entry.name);
      }
    } catch {
      // root 不存在（首次运行）时忽略，仅返回 DB 中的目录
    }

    return [...set].sort((a, b) => a.localeCompare(b));
  }

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

    const requiresReview = dto.requiresReview ?? false;
    const allowedModes =
      dto.allowedModes ??
      (requiresReview ? 'link_only,metadata_only,mirror_file' : 'link_only,mirror_file');

    try {
      return await this.sourceRepo.create({
        name: dto.name,
        slug: dto.slug,
        baseUrl: dto.baseUrl,
        sourceType: dto.sourceType,
        enabled: dto.enabled ?? true,
        allowedModes,
        termsUrl: dto.termsUrl,
        robotsUrl: dto.robotsUrl,
        rateLimitPerMinute: dto.rateLimitPerMinute ?? 30,
        downloadIntervalMs: dto.downloadIntervalMs ?? 1000,
        maxConcurrency: dto.maxConcurrency ?? 1,
        requiresReview,
        config: dto.config,
        autoSyncIntervalHours: dto.autoSyncIntervalHours,
        downloadDirectory: dto.downloadDirectory ?? null,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Source slug "${dto.slug}" already exists`);
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
        rateLimitPerMinute: dto.rateLimitPerMinute,
        downloadIntervalMs: dto.downloadIntervalMs,
        maxConcurrency: dto.maxConcurrency,
        requiresReview: dto.requiresReview,
        config: dto.config === undefined ? undefined : (dto.config as string | null),
        autoSyncIntervalHours:
          dto.autoSyncIntervalHours === undefined ? undefined : dto.autoSyncIntervalHours,
        downloadDirectory:
          dto.downloadDirectory === undefined ? undefined : (dto.downloadDirectory as string | null),
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Source slug "${dto.slug}" already exists`);
      }
      throw error;
    }
  }

  /** 删除来源（方案 B：允许删除有关联资源的来源，关联记录经外键 SetNull/Cascade 自动处理） */
  async deleteSource(id: string) {
    const result = await this.sourceRepo.delete(id);
    if (!result.deleted) {
      if (result.reason === 'not_found') {
        throw new NotFoundException(`Source ${id} not found`);
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
