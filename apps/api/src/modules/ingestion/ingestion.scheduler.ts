import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionService } from './ingestion.service';

@Injectable()
export class IngestionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionScheduler.name);
  private pollTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private running = false;
  private recovering = false;
  private healthChecking = false;
  private autoSyncing = false;
  private staleJobTimeoutMs = 60_000;
  private staleRecoveryIntervalMs = 30_000;
  private healthCheckIntervalMs = 6 * 60 * 60 * 1000; // 6 hours
  private healthCheckBatchSize = 10;
  private autoSyncCheckIntervalMs = 60_000; // 每分钟检查一次自动同步到期
  private autoSyncBatchSize = 10;
  private retrySweepTimer: NodeJS.Timeout | null = null;
  private retrySweeping = false;
  private retrySweepIntervalMs = 60_000; // 每分钟补漏一轮失败下载
  private retrySweepBatchSize = 20;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    if ((this.config.get<boolean>('execution.ingestionEnabled') ?? true) === false) {
      // 独立 Worker 模式：摄入调度仍由 API 承担，本进程不轮询，避免两进程并发同步
      this.logger.log('摄入调度已关闭（INGESTION_ENABLED=false）');
      return;
    }
    this.staleJobTimeoutMs =
      this.config.get<number>('ingestion.staleJobTimeoutMs') ?? this.staleJobTimeoutMs;
    const interval = this.config.get<number>('ingestion.pollIntervalMs') ?? 3000;
    this.staleRecoveryIntervalMs = Math.max(interval, Math.min(this.staleJobTimeoutMs / 2, 60_000));
    this.healthCheckIntervalMs =
      this.config.get<number>('ingestion.healthCheckIntervalMs') ?? this.healthCheckIntervalMs;
    this.healthCheckBatchSize =
      this.config.get<number>('ingestion.healthCheckBatchSize') ?? this.healthCheckBatchSize;
    this.autoSyncCheckIntervalMs =
      this.config.get<number>('ingestion.autoSyncCheckIntervalMs') ?? this.autoSyncCheckIntervalMs;
    this.autoSyncBatchSize =
      this.config.get<number>('ingestion.autoSyncBatchSize') ?? this.autoSyncBatchSize;
    this.retrySweepIntervalMs =
      this.config.get<number>('ingestion.retrySweepIntervalMs') ?? this.retrySweepIntervalMs;
    this.retrySweepBatchSize =
      this.config.get<number>('ingestion.retrySweepBatchSize') ?? this.retrySweepBatchSize;
    await this.recoverStaleJobs();
    this.pollTimer = setInterval(() => void this.poll(), interval);
    this.recoveryTimer = setInterval(
      () => void this.recoverStaleJobs(),
      this.staleRecoveryIntervalMs,
    );
    this.healthCheckTimer = setInterval(
      () => void this.scheduleHealthChecks(),
      this.healthCheckIntervalMs,
    );
    this.autoSyncTimer = setInterval(() => void this.runAutoSyncs(), this.autoSyncCheckIntervalMs);
    this.retrySweepTimer = setInterval(
      () => void this.sweepFailedDownloads(),
      this.retrySweepIntervalMs,
    );
    void this.poll();
    // 首次启动时也调度一轮健康检查、自动同步和失败下载补漏
    void this.scheduleHealthChecks();
    void this.runAutoSyncs();
    void this.sweepFailedDownloads();
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    if (this.autoSyncTimer) clearInterval(this.autoSyncTimer);
    if (this.retrySweepTimer) clearInterval(this.retrySweepTimer);
  }

  private async poll() {
    if (this.running) return;
    this.running = true;
    try {
      await this.ingestionService.runNextJob();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.running = false;
    }
  }

  private async recoverStaleJobs() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      await this.ingestionService.resetStaleJobs(this.staleJobTimeoutMs);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.recovering = false;
    }
  }

  private async scheduleHealthChecks() {
    if (this.healthChecking) return;
    this.healthChecking = true;
    try {
      const created = await this.ingestionService.scheduleLocatorHealthChecks(
        this.healthCheckBatchSize,
      );
      if (created > 0) {
        this.logger.log(`Scheduled ${created} locator health check jobs`);
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.healthChecking = false;
    }
  }

  private async sweepFailedDownloads() {
    if (this.retrySweeping) return;
    this.retrySweeping = true;
    try {
      const queued = await this.ingestionService.scheduleFailedDownloadRetries(
        this.retrySweepBatchSize,
      );
      if (queued > 0) {
        this.logger.log(`Queued ${queued} failed download retry job(s)`);
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.retrySweeping = false;
    }
  }

  private async runAutoSyncs() {
    if (this.autoSyncing) return;
    this.autoSyncing = true;
    try {
      const created = await this.ingestionService.scheduleAutoSyncs(this.autoSyncBatchSize);
      if (created > 0) {
        this.logger.log(`Scheduled ${created} auto sync job(s)`);
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.autoSyncing = false;
    }
  }
}
