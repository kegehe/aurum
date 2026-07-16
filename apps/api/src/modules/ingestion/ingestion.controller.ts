import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateLinkImportDto } from './dto/create-link-import.dto';
import { QueryIngestionJobsDto } from './dto/query-ingestion-jobs.dto';
import { IngestionService } from './ingestion.service';

@Controller()
export class IngestionController {
  constructor(private readonly ingestionService: IngestionService) {}

  @Post('imports/link')
  createLinkImport(@Body() dto: CreateLinkImportDto) {
    return this.ingestionService.createLinkImport(dto);
  }

  @Get('ingestion/jobs')
  listJobs(@Query() query: QueryIngestionJobsDto) {
    return this.ingestionService.listJobs(query);
  }

  @Get('ingestion/jobs/:id')
  getJob(@Param('id') id: string) {
    return this.ingestionService.getJob(id);
  }

  @Post('ingestion/jobs/:id/retry')
  retryJob(@Param('id') id: string) {
    return this.ingestionService.retryJob(id);
  }

  /** 手动触发资源所有定位器的健康检查 */
  @Post('resources/:id/locators/check')
  checkResourceLocators(@Param('id') id: string) {
    return this.ingestionService.checkResourceLocators(id);
  }
}
