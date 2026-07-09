import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ProcessingJob } from '@prisma/client';

/**
 * 处理任务仓储
 * 阶段1-5：只创建 pending 任务记录，不执行（阶段6接 Worker 才真正处理）
 */
@Injectable()
export class ProcessingJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.ProcessingJobCreateInput,
    tx?: Prisma.TransactionClient,
  ): Promise<ProcessingJob> {
    const client = tx ?? this.prisma;
    return client.processingJob.create({ data });
  }

  findByResourceId(resourceId: string): Promise<ProcessingJob[]> {
    return this.prisma.processingJob.findMany({
      where: { resourceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  findById(id: string): Promise<ProcessingJob | null> {
    return this.prisma.processingJob.findUnique({ where: { id } });
  }
}
