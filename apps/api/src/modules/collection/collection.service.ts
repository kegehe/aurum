import { Injectable, NotFoundException } from '@nestjs/common';
import { CollectionRepository } from './repositories/collection.repository';
import { CreateCollectionDto, UpdateCollectionDto } from './dto/collection.dto';

@Injectable()
export class CollectionService {
  constructor(private readonly collectionRepo: CollectionRepository) {}

  /** 集合列表 */
  async list() {
    const collections = await this.collectionRepo.findAllWithCover();
    return {
      items: collections.map((c) => {
        const { resources, ...rest } = c;
        const { deletedAt, ...coverResource } = c.coverResource ?? {};
        return {
          ...rest,
          coverResource: c.coverResource && !deletedAt ? coverResource : null,
          resourceCount: resources.length,
        };
      }),
    };
  }

  /** 集合详情 */
  async detail(id: string) {
    const collection = await this.collectionRepo.findByIdWithResources(id);
    if (!collection) throw new NotFoundException(`Collection ${id} not found`);
    const { deletedAt, ...coverResource } = collection.coverResource ?? {};
    return {
      ...collection,
      coverResource: collection.coverResource && !deletedAt ? coverResource : null,
      resourceCount: collection.resources.length,
      resources: collection.resources.map((cr) => ({
        ...cr.resource,
        sortOrder: cr.sortOrder,
        sizeBytes: cr.resource.sizeBytes.toString(),
      })),
    };
  }

  /** 创建集合 */
  async create(dto: CreateCollectionDto) {
    return this.collectionRepo.create({
      name: dto.name,
      description: dto.description,
      coverResourceId: dto.coverResourceId,
    });
  }

  /** 更新集合 */
  async update(id: string, dto: UpdateCollectionDto) {
    const existing = await this.collectionRepo.findById(id);
    if (!existing) throw new NotFoundException(`Collection ${id} not found`);
    return this.collectionRepo.update(id, {
      name: dto.name,
      description: dto.description,
      coverResourceId: dto.coverResourceId,
    });
  }

  /** 删除集合（软删除） */
  async delete(id: string) {
    const existing = await this.collectionRepo.findById(id);
    if (!existing) throw new NotFoundException(`Collection ${id} not found`);
    return this.collectionRepo.softDelete(id);
  }

  /** 添加资源到集合 */
  async addResource(collectionId: string, resourceId: string) {
    const collection = await this.collectionRepo.findById(collectionId);
    if (!collection) throw new NotFoundException(`Collection ${collectionId} not found`);
    await this.collectionRepo.addResource(collectionId, resourceId);
    return { collectionId, resourceId, action: 'added' };
  }

  /** 从集合移除资源 */
  async removeResource(collectionId: string, resourceId: string) {
    const collection = await this.collectionRepo.findById(collectionId);
    if (!collection) throw new NotFoundException(`Collection ${collectionId} not found`);
    await this.collectionRepo.removeResource(collectionId, resourceId);
    return { collectionId, resourceId, action: 'removed' };
  }

  /** 批量添加资源到集合 */
  async batchAddResources(collectionId: string, resourceIds: string[]) {
    const collection = await this.collectionRepo.findById(collectionId);
    if (!collection) throw new NotFoundException(`Collection ${collectionId} not found`);
    const count = await this.collectionRepo.batchAddResources(collectionId, resourceIds);
    return { collectionId, resourceIds, added: count };
  }

  /** 更新集合内资源排序 */
  async updateSortOrder(collectionId: string, resourceId: string, sortOrder: number) {
    await this.collectionRepo.updateResourceSortOrder(collectionId, resourceId, sortOrder);
    return { collectionId, resourceId, sortOrder };
  }
}
