import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DesignAssetSnapshotService } from '../design-asset-snapshot.service';
import { PreviewSnapshotJobService } from './preview-snapshot-job.service';

@Injectable()
export class PreviewSnapshotWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewSnapshotWorker.name);
  private readonly enabled: boolean;
  private readonly workerId = `snapshot-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly jobs: PreviewSnapshotJobService,
    private readonly snapshots: DesignAssetSnapshotService,
    config: ConfigService,
  ) {
    // 未显式配置时跟随处理任务开关：单进程部署（只跑 API）也要能生成快照；
    // 拆出独立 Worker 时 API 侧 EXECUTION_ENABLED=false，自然不再执行快照任务。
    const explicit = process.env.SNAPSHOT_JOB_WORKER;
    this.enabled =
      explicit === undefined
        ? (config.get<boolean>('execution.processingEnabled') ?? true)
        : explicit === 'true';
  }

  onModuleInit() {
    if (!this.enabled) return;
    this.logger.log(`快照 Worker 已启动：${this.workerId}`);
    this.timer = setInterval(() => void this.tick(), 2_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.jobs.reclaimExpired();
      for (let index = 0; index < 4; index += 1) {
        const job = await this.jobs.claim(this.workerId);
        if (!job) break;
        try {
          const result = await this.snapshots.captureVersion(job.versionId, {
            viewport: job.viewport,
            state: job.state,
            kind: job.kind,
          });
          const completed = await this.jobs.complete(job.id, this.workerId, {
            storagePath: result.storagePath,
            artifactHash: result.artifactHash,
          });
          if (!completed) {
            this.logger.warn(`快照任务 ${job.id} 的租约已失效，本次结果已丢弃`);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`快照任务 ${job.id} 失败：${message}`);
          const recorded = await this.jobs.fail(job.id, this.workerId, message);
          if (!recorded) {
            this.logger.warn(`快照任务 ${job.id} 的租约已失效，失败状态未写入`);
          }
        }
      }
    } catch (error) {
      this.logger.error(
        `快照 Worker tick 失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
