import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DesignService } from './design.service';

@Injectable()
export class DesignTaskProcessor {
  private readonly logger = new Logger(DesignTaskProcessor.name);
  private running = false;

  constructor(private readonly designService: DesignService) {}

  @Interval(1_000)
  async process() {
    if (this.running) return;
    this.running = true;
    try {
      await this.designService.processNextTask();
    } catch (error) {
      this.logger.error(
        `Design task processing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  @Interval(60 * 60 * 1000)
  async cleanupExpiredReferences() {
    try {
      await this.designService.cleanupExpiredReferenceSnapshots();
    } catch (error) {
      this.logger.error(
        `Design reference cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
