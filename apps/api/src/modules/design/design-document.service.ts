import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 设计文档的读写。
 *
 * 目前只承载发布流程需要的读取；`design.service.ts` 里其余的文档方法
 * （列表、创建、搜索、导出）会在后续轮次陆续迁进来——按工作流分簇抽取，
 * 每簇都要先有特征化测试再动。
 */
@Injectable()
export class DesignDocumentService {
  constructor(private readonly prisma: PrismaService) {}

  /** 取文档详情：当前正式版本、最近 30 个版本、以及它依赖的上游文档/版本。 */
  async getDocument(id: string) {
    const document = await this.prisma.designDocument.findUnique({
      where: { id },
      include: {
        currentPublishedVersion: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 30 },
        dependenciesFrom: { include: { toDocument: true, toVersion: true } },
      },
    });
    if (!document) throw new NotFoundException(`设计文档 ${id} 不存在`);
    return document;
  }
}
