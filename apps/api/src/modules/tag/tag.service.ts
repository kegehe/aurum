import { Injectable, NotFoundException } from '@nestjs/common';
import { TagRepository } from './repositories/tag.repository';
import { CreateTagDto, UpdateTagDto } from './dto/tag.dto';

@Injectable()
export class TagService {
  constructor(private readonly tagRepo: TagRepository) {}

  /** 标签列表（含使用次数） */
  async list() {
    const tags = await this.tagRepo.findAllWithUsage();
    return { items: tags };
  }

  /** 创建标签 */
  async create(dto: CreateTagDto) {
    return this.tagRepo.create({ name: dto.name, color: dto.color });
  }

  /** 更新标签 */
  async update(id: string, dto: UpdateTagDto) {
    const existing = await this.tagRepo.findById(id);
    if (!existing) throw new NotFoundException(`Tag ${id} not found`);
    return this.tagRepo.update(id, { name: dto.name, color: dto.color });
  }

  /** 删除标签 */
  async delete(id: string) {
    const existing = await this.tagRepo.findById(id);
    if (!existing) throw new NotFoundException(`Tag ${id} not found`);
    const usage = await this.tagRepo.usageCount(id);
    await this.tagRepo.delete(id);
    return { id, deleted: true, previousUsage: usage };
  }

  /** 为资源添加标签 */
  async addToResource(resourceId: string, tagId: string) {
    await this.tagRepo.addToResource(resourceId, tagId);
    return { resourceId, tagId, action: 'added' };
  }

  /** 从资源移除标签 */
  async removeFromResource(resourceId: string, tagId: string) {
    await this.tagRepo.removeFromResource(resourceId, tagId);
    return { resourceId, tagId, action: 'removed' };
  }

  /** 批量添加标签 */
  async batchAdd(resourceIds: string[], tagIds: string[]) {
    const count = await this.tagRepo.batchAddToResources(resourceIds, tagIds);
    return { resourceIds, tagIds, added: count };
  }

  /** 批量移除标签 */
  async batchRemove(resourceIds: string[], tagIds: string[]) {
    const count = await this.tagRepo.batchRemoveFromResources(resourceIds, tagIds);
    return { resourceIds, tagIds, removed: count };
  }
}
