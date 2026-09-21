import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * 全局 Prisma 服务
 *
 * SQLite 默认不开启外键约束，需要在连接后显式执行 PRAGMA foreign_keys = ON，
 * 否则 onDelete: Cascade / SetNull 不会生效。
 * 切换 PostgreSQL 时这些 PRAGMA 语句均不适用（PG 原生支持外键与行级并发）。
 *
 * WAL 与 busy_timeout 是多进程（API + 独立 Worker）共享同一个 db 文件的前提：
 * 默认 journal_mode=delete 下写事务会直接阻塞读，busy_timeout 让偶发的写锁竞争
 * 排队等待而不是立刻抛 SQLITE_BUSY。journal_mode 是库级持久设置，重复执行为幂等。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    await this.$connect();
    await this.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    // journal_mode / busy_timeout 都会回一行结果，用 execute 会被 Prisma 判为
    // "Execute returned results"（P2010），因此按查询执行并丢弃返回值。
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
    this.logger.log('Prisma connected, SQLite foreign keys / WAL / busy_timeout enabled');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
