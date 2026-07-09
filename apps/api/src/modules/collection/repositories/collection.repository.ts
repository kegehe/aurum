import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Collection } from '@prisma/client';

/**
 * 集合仓储（阶段7完整实现）
 */
@Injectable()
export class CollectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Collection[]> {
    return this.prisma.collection.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  findById(id: string): Promise<Collection | null> {
    return this.prisma.collection.findUnique({ where: { id } });
  }
}
