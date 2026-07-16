import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ConsistencyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listResourceFilePaths(): Promise<string[]> {
    const files = await this.prisma.resourceFile.findMany({
      select: { storagePath: true },
      orderBy: { storagePath: 'asc' },
    });
    return files.map((file) => file.storagePath);
  }
}
