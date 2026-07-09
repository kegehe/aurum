import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ResourceRepository } from './repositories/resource.repository';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { FileRole } from '../../common/constants/enums';
import { QueryResourceDto, ResourceSortField, SortOrder } from './dto/query-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';

@Injectable()
export class ResourceService {
  constructor(
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
  ) {}

  /**
   * 分页查询资源列表（默认排除已软删除）
   */
  async findMany(query: QueryResourceDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.ResourceWhereInput = {
      deletedAt: query.includeDeleted ? undefined : null,
    };
    if (query.resourceType) where.resourceType = query.resourceType;
    if (query.categoryId) where.categoryId = query.categoryId;
    if (query.isFavorite !== undefined) where.isFavorite = query.isFavorite;
    if (query.processingStatus) where.processingStatus = query.processingStatus;
    if (query.tagId) where.tags = { some: { tagId: query.tagId } };
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword } },
        { originalFilename: { contains: query.keyword } },
        { description: { contains: query.keyword } },
      ];
    }

    const orderBy = this.buildOrderBy(query.sortBy, query.sortOrder);

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

  private buildOrderBy(
    sortBy?: ResourceSortField,
    sortOrder?: SortOrder,
  ): Prisma.ResourceOrderByWithRelationInput {
    const field = sortBy ?? ResourceSortField.createdAt;
    const order = sortOrder ?? SortOrder.desc;
    return { [field]: order };
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

  /**
   * 获取原文件可读流（用于下载）
   * 安全：通过 resource_id 查 DB 取 storage_path，不接受客户端传入路径
   */
  async getOriginalFile(id: string): Promise<{
    stream: NodeJS.ReadableStream;
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
}
