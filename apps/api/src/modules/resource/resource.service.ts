import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZipArchive } from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { ResourceRepository } from './repositories/resource.repository';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { TagRepository } from '../tag/repositories/tag.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { IJobScheduler, JOB_SCHEDULER } from '../processing/interfaces/job-scheduler.interface';
import { SearchService } from '../search/search.service';
import { FileRole } from '../../common/constants/enums';
import { JobType, ProcessingStatus } from '../../common/constants/enums';
import { SearchResourceDto } from '../search/dto/search-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';

@Injectable()
export class ResourceService {
  constructor(
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly tagRepo: TagRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly searchService: SearchService,
  ) {}

  /**
   * 分页查询资源列表（默认排除已软删除）
   * 搜索/筛选逻辑委托 SearchService.buildWhereClause()
   */
  async findMany(query: SearchResourceDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = this.searchService.buildWhereClause(query);
    const orderBy = this.searchService.buildOrderBy(query.sortBy, query.sortOrder);

    const [items, total] = await Promise.all([
      this.resourceRepo.findMany({ where, orderBy, page, pageSize }),
      this.resourceRepo.count(where),
    ]);

    // BigInt 无法 JSON 序列化，转成字符串
    const serializedItems = items.map((item) => ({
      ...item,
      sizeBytes: item.sizeBytes.toString(),
    }));

    return {
      items: serializedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 轻量查询：仅获取资源基础字段（不含关联数据）
   * 用于缩略图端点等只需少量字段的场景，避免加载 files/tags/locators 等关联
   */
  async findBasicById(id: string) {
    return this.resourceRepo.findById(id);
  }

  /**
   * 资源详情：含文件列表、标签、重复提示
   */
  async findById(id: string) {
    const resource = await this.resourceRepo.findByIdWithRelations(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }

    return {
      ...resource,
      sizeBytes: resource.sizeBytes.toString(),
      files: resource.files.map((f) => ({ ...f, sizeBytes: f.sizeBytes.toString() })),
      locators: resource.locators.map((locator) => ({
        ...locator,
        contentLength: locator.contentLength?.toString() ?? null,
      })),
      tags: resource.tags.map((rt) => rt.tag),
      isDuplicate: !!resource.duplicateOfId,
      duplicateOf: resource.duplicateOf,
    };
  }

  /** 更新资源元数据 */
  async update(id: string, dto: UpdateResourceDto) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const data: Prisma.ResourceUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.author !== undefined) data.author = dto.author;
    if (dto.licenseNote !== undefined) data.licenseNote = dto.licenseNote;
    if (dto.categoryId !== undefined) {
      data.category = dto.categoryId ? { connect: { id: dto.categoryId } } : { disconnect: true };
    }
    const updated = await this.resourceRepo.update(id, data);
    return { ...updated, sizeBytes: updated.sizeBytes.toString() };
  }

  async batchSetCategory(ids: string[], categoryId: string | null) {
    const updated = await this.resourceRepo.batchSetCategory(ids, categoryId);
    return {
      resourceIds: ids,
      categoryId,
      updated,
      failed: ids.length - updated,
    };
  }

  async batchSetFavorite(ids: string[], isFavorite: boolean) {
    const updated = await this.resourceRepo.batchSetFavorite(ids, isFavorite);
    return {
      resourceIds: ids,
      isFavorite,
      updated,
      failed: ids.length - updated,
    };
  }

  async batchSoftDelete(ids: string[]) {
    const deleted = await this.resourceRepo.batchSoftDelete(ids);
    return {
      resourceIds: ids,
      deleted,
      failed: ids.length - deleted,
    };
  }

  async batchAddTags(resourceIds: string[], tagIds: string[]) {
    const added = await this.tagRepo.batchAddToResources(resourceIds, tagIds);
    return { resourceIds, tagIds, added };
  }

  async batchRemoveTags(resourceIds: string[], tagIds: string[]) {
    const removed = await this.tagRepo.batchRemoveFromResources(resourceIds, tagIds);
    return { resourceIds, tagIds, removed };
  }

  async createBatchDownload(ids: string[]): Promise<{
    stream: Readable;
    filename: string;
    foundResources: number;
    missingResources: number;
  }> {
    const resources = await this.resourceRepo.findActiveOriginalFiles(ids);
    const downloadableResources = resources.filter((resource) => resource.files.length > 0);
    if (downloadableResources.length === 0) {
      throw new NotFoundException('No downloadable resources found');
    }

    const archive = new ZipArchive({ zlib: { level: 9 } });
    const output = new PassThrough();
    const usedNames = new Map<string, number>();
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);

    setImmediate(() => {
      void (async () => {
        try {
          for (const resource of downloadableResources) {
            const [originalFile] = resource.files;
            const stream = await this.storage.getStream(originalFile.storagePath);
            archive.append(stream, {
              name: this.uniqueArchiveName(
                this.safeArchiveName(resource.originalFilename || resource.title || resource.id),
                usedNames,
              ),
            });
          }
          await archive.finalize();
        } catch (e) {
          archive.destroy(e instanceof Error ? e : new Error(String(e)));
          output.destroy(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    return {
      stream: output,
      filename: `resources-${new Date().toISOString().slice(0, 10)}.zip`,
      foundResources: downloadableResources.length,
      missingResources: ids.length - downloadableResources.length,
    };
  }

  /**
   * 获取原文件可读流（用于下载）
   * 安全：通过 resource_id 查 DB 取 storage_path，不接受客户端传入路径
   */
  async getOriginalFile(id: string): Promise<{
    stream: Readable;
    mimeType: string;
    originalFilename: string;
  }> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const originalFile = await this.fileRepo.findByResourceAndRole(id, FileRole.original);
    if (!originalFile) {
      throw new NotFoundException(`Original file for resource ${id} not found`);
    }
    const stream = await this.storage.getStream(originalFile.storagePath);
    return {
      stream,
      mimeType: resource.mimeType,
      originalFilename: resource.originalFilename,
    };
  }

  /**
   * 获取缩略图可读流
   * 如果缩略图尚未生成，返回 null
   */
  async getThumbnailFile(id: string): Promise<{
    stream: Readable;
    mimeType: string;
  } | null> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const thumbnailFile = await this.fileRepo.findByResourceAndRole(id, FileRole.thumbnail);
    if (!thumbnailFile) {
      return null;
    }
    const stream = await this.storage.getStream(thumbnailFile.storagePath);
    return {
      stream,
      mimeType: thumbnailFile.mimeType || 'image/webp',
    };
  }

  /** 软删除 */
  async softDelete(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.softDelete(id);
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 恢复 */
  async restore(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.restore(id);
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 彻底删除：清理磁盘文件和数据库记录。只允许删除已在回收站中的资源。 */
  async permanentDelete(id: string) {
    const resource = await this.resourceRepo.findByIdWithRelations(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    if (!resource.deletedAt) {
      throw new BadRequestException(`Resource ${id} is not in trash`);
    }

    await Promise.all(resource.files.map((file) => this.storage.delete(file.storagePath)));
    await this.resourceRepo.deleteDeleted(id);

    return {
      id,
      deleted: true,
      deletedFiles: resource.files.length,
    };
  }

  /** 清空回收站 */
  async emptyTrash() {
    const resources = await this.resourceRepo.findDeletedWithFiles();
    let deletedResources = 0;
    let deletedFiles = 0;
    for (const resource of resources) {
      try {
        const storagePaths = resource.files.map((file) => file.storagePath);
        await Promise.all(storagePaths.map((path) => this.storage.delete(path)));
        await this.resourceRepo.deleteDeleted(resource.id);
        deletedResources++;
        deletedFiles += storagePaths.length;
      } catch (e) {
        if (!(e instanceof NotFoundException)) {
          throw e;
        }
      }
    }

    return {
      deletedResources,
      deletedFiles,
    };
  }

  /** 重新处理：创建新的元数据检测任务，并标记资源正在处理 */
  async reprocess(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    // 创建新的检测任务（调度器会自动去重）
    await this.scheduler.enqueue(JobType.detect_metadata, id);
    await this.resourceRepo.updateProcessingStatus(id, ProcessingStatus.processing);
    return { id, processingStatus: ProcessingStatus.processing };
  }

  /** 为资源添加标签 */
  async addTag(resourceId: string, tagId: string) {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    await this.tagRepo.addToResource(resourceId, tagId);
    return { resourceId, tagId, action: 'added' };
  }

  /** 从资源移除标签 */
  async removeTag(resourceId: string, tagId: string) {
    const resource = await this.resourceRepo.findById(resourceId);
    if (!resource) throw new NotFoundException(`Resource ${resourceId} not found`);
    await this.tagRepo.removeFromResource(resourceId, tagId);
    return { resourceId, tagId, action: 'removed' };
  }

  private safeArchiveName(name: string): string {
    const cleaned = name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'resource';
  }

  private uniqueArchiveName(name: string, usedNames: Map<string, number>): string {
    const current = usedNames.get(name) ?? 0;
    usedNames.set(name, current + 1);
    if (current === 0) return name;

    const dotIndex = name.lastIndexOf('.');
    if (dotIndex <= 0) return `${name}-${current + 1}`;
    return `${name.slice(0, dotIndex)}-${current + 1}${name.slice(dotIndex)}`;
  }
}
