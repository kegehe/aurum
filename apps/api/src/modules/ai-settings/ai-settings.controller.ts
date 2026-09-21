import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AiSettingsService } from './ai-settings.service';
import { CreateAiProviderDto } from './dto/create-ai-provider.dto';
import { UpdateAiProviderDto } from './dto/update-ai-provider.dto';
import { TestAiProviderDto } from './dto/test-ai-provider.dto';

/**
 * AI 供应商配置管理
 *
 * 在「设置 → AI 配置」页面配置 API Key / Base URL / 模型，
 * 配置立即生效，无需修改 .env 或重启 API。
 */
@Controller('ai-settings')
export class AiSettingsController {
  constructor(private readonly aiSettings: AiSettingsService) {}

  /** 运行时生效配置摘要（含环境变量回退状态） */
  @Get('summary')
  summary() {
    return this.aiSettings.summary;
  }

  /** 配置列表（密钥已掩码） */
  @Get()
  list() {
    return this.aiSettings.listProviders();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.aiSettings.getProvider(id);
  }

  @Post()
  create(@Body() dto: CreateAiProviderDto) {
    return this.aiSettings.createProvider(dto);
  }

  /** 测试未保存的临时配置（用于表单内「测试」按钮） */
  @Post('test')
  testAdHoc(@Body() dto: TestAiProviderDto) {
    return this.aiSettings.testAdHoc(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAiProviderDto) {
    return this.aiSettings.updateProvider(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.aiSettings.deleteProvider(id);
  }

  /** 设为生效 */
  @Post(':id/activate')
  activate(@Param('id') id: string) {
    return this.aiSettings.activateProvider(id);
  }

  /** 测试已保存的配置并记录结果 */
  @Post(':id/test')
  testSaved(@Param('id') id: string) {
    return this.aiSettings.testSavedProvider(id);
  }
}
