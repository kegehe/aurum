import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IngestionService } from './ingestion.service';

@Injectable()
export class IngestionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionScheduler.name);
  private pollTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private running = false;
  private recovering = false;
  private staleJobTimeoutMs = 60_000;
  private staleRecoveryIntervalMs = 30_000;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    this.staleJobTimeoutMs = this.config.get<number>('ingestion.staleJobTimeoutMs')!;
    const interval = this.config.get<number>('ingestion.pollIntervalMs')!;
    this.staleRecoveryIntervalMs = Math.max(interval, Math.min(this.staleJobTimeoutMs / 2, 60_000));
    await this.recoverStaleJobs();
    this.pollTimer = setInterval(() => void this.poll(), interval);
    this.recoveryTimer = setInterval(() => void this.recoverStaleJobs(), this.staleRecoveryIntervalMs);
    void this.poll();
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
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
}
