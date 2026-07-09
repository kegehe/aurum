import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * 全局 Prisma 服务
 *
 * SQLite 默认不开启外键约束，需要在连接后显式执行 PRAGMA foreign_keys = ON，
 * 否则 onDelete: Cascade / SetNull 不会生效。
 * 切换 PostgreSQL 时此 PRAGMA 语句无害（PG 原生支持外键）。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    // 开启 SQLite 外键约束
    await this.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    this.logger.log('Prisma connected, SQLite foreign keys enabled');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
