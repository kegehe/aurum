import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CreateLinkImportDto } from './dto/create-link-import.dto';
import { QueryIngestionJobsDto } from './dto/query-ingestion-jobs.dto';
import { BatchResourceIdsDto } from '../resource/dto/batch-resource.dto';
import { IngestionService } from './ingestion.service';

@Controller()
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('imports/link')
  createLinkImport(@Body() dto: CreateLinkImportDto) {
    return this.ingestionService.createLinkImport(dto);
  }

  @Post('imports/sources/:sourceId/sync')
  createSourceSync(@Param('sourceId') sourceId: string) {
    return this.ingestionService.createSourceSync(sourceId);
  }

  @Get('ingestion/jobs')
  listJobs(@Query() query: QueryIngestionJobsDto) {
    return this.ingestionService.listJobs(query);
  }

  /** 摄入任务统计（各状态数量） */
  @Get('ingestion/stats')
  stats() {
    return this.ingestionService.getStats();
  }

  @Get('ingestion/jobs/:id')
  getJob(@Param('id') id: string) {
    return this.ingestionService.getJob(id);
  }

  @Post('ingestion/jobs/:id/retry')
  retryJob(@Param('id') id: string) {
    return this.ingestionService.retryJob(id);
  }

  @Post('ingestion/jobs/:id/cancel')
  cancelJob(@Param('id') id: string) {
    return this.ingestionService.cancelJob(id);
  }

  /** 删除指定已结束（terminal）的任务记录 */
  @Delete('ingestion/jobs/:id')
  deleteJob(@Param('id') id: string) {
    return this.ingestionService.deleteJob(id);
  }

  /** 清空所有已结束（terminal）的任务记录 */
  @Delete('ingestion/jobs')
  clearJobs() {
    return this.ingestionService.clearJobs();
  }

  /**
   * 清除远端条目台账（同步记录），可选按来源过滤。
   *
   * 台账用于「同一条目只下载一次」：即使资源被彻底删除，后续同步也不会重复下载。
   * 想重新下载这些条目时清除台账即可。
   */
  @Delete('ingestion/sync-history')
  clearSyncHistory(@Query('sourceId') sourceId?: string) {
    return this.ingestionService.clearSyncHistory(sourceId);
  }

  /** 批量重试下载失败的远程资源（可选限定来源） */
  @Post('ingestion/retry-failed-downloads')
  retryFailedDownloads(@Query('sourceId') sourceId?: string, @Query('limit') limit?: string) {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    return this.ingestionService.retryFailedDownloads({
      sourceId: sourceId || undefined,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }

  /** 手动触发资源所有定位器的健康检查 */
  @Post('resources/:id/locators/check')
  checkResourceLocators(@Param('id') id: string) {
    return this.ingestionService.checkResourceLocators(id);
  }

  /**
   * 批量把选中的远程资源下载到本地。
   * 必须声明在 `resources/:id/mirror` 之前，否则 "batch" 会被当作资源 ID 匹配。
   */
  @Post('resources/batch/mirror')
  mirrorRemoteResources(@Body() dto: BatchResourceIdsDto) {
    return this.ingestionService.mirrorRemoteResources(dto.resourceIds);
  }

  /** Download a reviewed remote resource into local storage. */
  @Post('resources/:id/mirror')
  mirrorRemoteResource(@Param('id') id: string) {
    return this.ingestionService.mirrorRemoteResource(id);
  }

  /** 抓取资源页面的 HTML 快照（archive_snapshot 采集方式） */
  @Post('resources/:id/snapshot')
  createPageSnapshot(@Param('id') id: string) {
    return this.ingestionService.createPageSnapshot(id);
  }
}
