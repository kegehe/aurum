import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ResourceFile } from '@prisma/client';

/**
 * 资源文件仓储
 * 管理 resource_files 表（原文件和派生文件记录）
 */
@Injectable()
export class ResourceFileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.ResourceFileCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ResourceFile> {
    const client = tx ?? this.prisma;
    return client.resourceFile.create({ data });
  }

  findByResourceId(resourceId: string): Promise<ResourceFile[]> {
    return this.prisma.resourceFile.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findByResourceAndRole(
    resourceId: string,
    fileRole: string,
    variant: string = '',
  ): Promise<ResourceFile | null> {
    return this.prisma.resourceFile.findUnique({
      where: {
        resourceId_fileRole_variant: { resourceId, fileRole, variant },
      },
    });
  }

  /**
   * 查询这些 storagePath 当前分别被哪些资源引用。
   *
   * 存储 key 按内容哈希生成（如 `originals/ab/cd/<sha256>.original.png`），
   * 所以同一份文件上传两次、或把一份文件删进回收站后再上传一次时，
   * 多条 ResourceFile 会指向同一份磁盘文件。删除磁盘文件前必须用这里确认
   * 没有别的资源还在引用，否则会连带删掉对方的原文件 / 缩略图。
   *
   * storagePath 上有索引（见 20261112234400_add_resource_file_storage_path_index），
   * 但按 500 条分批仍保留：避免一次 IN 查询携带过多参数（SQLite 的变量数上限）。
   */
  async findStoragePathReferences(storagePaths: string[]): Promise<Map<string, Set<string>>> {
    const references = new Map<string, Set<string>>();
    const uniquePaths = [...new Set(storagePaths)];
    const chunkSize = 500;

    for (let offset = 0; offset < uniquePaths.length; offset += chunkSize) {
      const chunk = uniquePaths.slice(offset, offset + chunkSize);
      const rows = await this.prisma.resourceFile.findMany({
        where: { storagePath: { in: chunk } },
        select: { storagePath: true, resourceId: true },
      });
      for (const row of rows) {
        let resourceIds = references.get(row.storagePath);
        if (!resourceIds) {
          resourceIds = new Set<string>();
          references.set(row.storagePath, resourceIds);
        }
        resourceIds.add(row.resourceId);
      }
    }

    return references;
  }
}
