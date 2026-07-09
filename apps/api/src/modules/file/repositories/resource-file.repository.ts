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
}
