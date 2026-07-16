import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * 临时文件定时清理
 *
 * 每小时检查 storage/temp/ 目录，删除超过 TEMP_FILE_TTL_SECONDS 的临时文件。
 * 使用 @nestjs/schedule 的 Cron 装饰器，无需额外轮询逻辑。
 */
@Injectable()
export class TempCleanupCron {
  private readonly logger = new Logger(TempCleanupCron.name);

  constructor(private readonly config: ConfigService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup(): Promise<void> {
    const root = this.config.get<string>('storage.root')!;
    const tempDir = path.resolve(root, 'temp');
    const ttl = this.config.get<number>('upload.tempTtlSeconds')! * 1000;
    const now = Date.now();

    try {
      const entries = await fs.readdir(tempDir, { withFileTypes: true });
      let cleaned = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(tempDir, entry.name);
        let stat;
        try {
          stat = await fs.stat(dirPath);
        } catch {
          continue; // 文件/目录可能已被删除
        }
        if (now - stat.mtimeMs > ttl) {
          await fs.rm(dirPath, { recursive: true, force: true });
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.logger.log(`Cleaned up ${cleaned} temp directories`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // temp 目录可能不存在（首次启动），不视为错误
      if (!msg.includes('ENOENT')) {
        this.logger.warn(`Temp cleanup failed: ${msg}`);
      }
    }
  }
}
