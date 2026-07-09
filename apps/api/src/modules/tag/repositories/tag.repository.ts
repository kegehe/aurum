import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Tag } from '@prisma/client';

/**
 * 标签仓储（阶段7完整实现）
 */
@Injectable()
export class TagRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Tag[]> {
    return this.prisma.tag.findMany({ orderBy: { name: 'asc' } });
  }

  findByName(name: string): Promise<Tag | null> {
    return this.prisma.tag.findUnique({ where: { name } });
  }
}
