import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { CreateCandidateDto } from './dto/create-candidate.dto';
import {
  ComposeAutoDto,
  ComposeGenerateDto,
  ComposePreviewDto,
  ComposePublishDto,
  ComposeRecipeDto,
} from './dto/compose-publish.dto';
import { CreateDesignDocumentDto } from './dto/create-design-document.dto';
import { GenerateAiCandidatesDto } from './dto/generate-ai-candidates.dto';
import { DesignService } from './design.service';
import { CreateUrlReferenceDraftDto } from './dto/create-url-reference-draft.dto';
import { AcceptReferenceTermsDto } from './dto/accept-reference-terms.dto';
import { DesignReferenceService } from './design-reference.service';
import {
  STORAGE_SERVICE,
  type IStorageService,
} from '../storage/interfaces/storage-service.interface';
import { DesignInternalGuard } from './design-internal.guard';
import { DesignAssetService, type AssetExportFormat, type AssetListQuery } from './design-asset.service';
import { CreateDesignAssetDto } from './dto/create-design-asset.dto';
import { CreateStudioSessionDto } from './dto/create-studio-session.dto';
import { SaveDesignAssetVersionDto } from './dto/save-design-asset-version.dto';
import { SaveDesignTokenVersionDto } from './dto/save-design-token-version.dto';
import { RebuildTokenDependentsDto } from './dto/rebuild-token-dependents.dto';
import { TokenAiDto } from './dto/token-ai.dto';
import { TokenContentDto } from './dto/token-content.dto';
import { SaveStudioSessionDto } from './dto/save-studio-session.dto';
import { SendStudioMessageDto } from './dto/send-studio-message.dto';
import { DesignStudioService } from './design-studio.service';
import {
  PreviewCompileService,
  type PreviewFile,
  type PreviewManifest,
} from './preview/preview-compiler.service';
import {
  PreviewSnapshotService,
  type PreviewState,
  type PreviewViewport,
} from './preview/preview-snapshot.service';
import type { ExportFormat } from './design-export';

@Controller('design')
@UseGuards(DesignInternalGuard)
export class DesignController {
  constructor(
    private readonly designService: DesignService,
    private readonly designReferenceService: DesignReferenceService,
    private readonly designAssetService: DesignAssetService,
    private readonly designStudioService: DesignStudioService,
    private readonly previewCompile: PreviewCompileService,
    private readonly previewSnapshot: PreviewSnapshotService,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
  ) {}

  @Post('assets')
  createAsset(@Body() dto: CreateDesignAssetDto) {
    return this.designAssetService.create({
      manifest: dto.manifest as unknown as PreviewManifest,
      files: dto.files as unknown as PreviewFile[],
      publish: dto.publish,
      tags: dto.tags,
    });
  }

  @Get('assets')
  listAssets(@Query() query: AssetListQuery) {
    return this.designAssetService.list(query);
  }

  @Post('assets/seed-sample')
  seedSampleAsset() {
    return this.designAssetService.seedSample();
  }

  @Get('assets/:idOrSlug')
  getAsset(@Param('idOrSlug') idOrSlug: string) {
    return this.designAssetService.get(idOrSlug);
  }

  @Get('assets/:idOrSlug/preview')
  getAssetPreview(@Param('idOrSlug') idOrSlug: string) {
    return this.designAssetService.previewAsset(idOrSlug);
  }

  @Post('assets/:idOrSlug/versions')
  saveAssetVersion(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: SaveDesignAssetVersionDto,
  ) {
    return this.designAssetService.saveVersion(idOrSlug, {
      files: dto.files as unknown as PreviewFile[],
      summary: dto.summary,
      publish: dto.publish,
      expectedBaseVersionId: dto.baseVersionId,
    });
  }

  @Get('assets/:idOrSlug/dependents')
  listAssetTokenDependents(@Param('idOrSlug') idOrSlug: string) {
    return this.designAssetService.listTokenDependents(idOrSlug);
  }

  @Post('assets/:idOrSlug/dependents/rebuild')
  rebuildAssetTokenDependents(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: RebuildTokenDependentsDto,
  ) {
    return this.designAssetService.rebuildTokenDependents(
      idOrSlug,
      dto.documentIds,
    );
  }

  @Post('assets/:idOrSlug/token-ai')
  generateAssetTokenPatch(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: TokenAiDto,
  ) {
    return this.designAssetService.generateTokenPatch(
      idOrSlug,
      dto.content,
      dto.request,
    );
  }

  @Post('assets/:idOrSlug/token-contrast')
  checkAssetTokenContrast(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: TokenContentDto,
  ) {
    return this.designAssetService.checkTokenContrast(idOrSlug, dto.content);
  }

  @Post('assets/:idOrSlug/token-versions')
  saveAssetTokenVersion(
    @Param('idOrSlug') idOrSlug: string,
    @Body() dto: SaveDesignTokenVersionDto,
  ) {
    return this.designAssetService.saveTokenVersion(idOrSlug, {
      content: dto.content,
      summary: dto.summary,
    });
  }

  @Get('assets/:idOrSlug/versions')
  listAssetVersions(@Param('idOrSlug') idOrSlug: string) {
    return this.designAssetService.listVersions(idOrSlug);
  }

  @Get('assets/:idOrSlug/versions/:versionId')
  getAssetVersion(
    @Param('idOrSlug') idOrSlug: string,
    @Param('versionId') versionId: string,
  ) {
    return this.designAssetService.getVersion(idOrSlug, versionId);
  }

  @Get('assets/:idOrSlug/versions/:versionId/diff')
  diffAssetVersion(
    @Param('idOrSlug') idOrSlug: string,
    @Param('versionId') versionId: string,
    @Query('againstVersionId') againstVersionId?: string,
  ) {
    if (!againstVersionId) throw new BadRequestException('缺少 againstVersionId');
    return this.designAssetService.diffVersions(idOrSlug, versionId, againstVersionId);
  }

  @Get('assets/:idOrSlug/cover')
  async getAssetCover(@Param('idOrSlug') idOrSlug: string, @Res() res: Response) {
    const png = await this.designAssetService.getCover(idOrSlug);
    if (!png) throw new NotFoundException('该资产还没有封面快照');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  }

  @Post('assets/:idOrSlug/snapshot')
  captureAssetSnapshot(@Param('idOrSlug') idOrSlug: string) {
    return this.designAssetService.captureSnapshot(idOrSlug);
  }

  @Get('assets/:idOrSlug/export')
  exportAsset(
    @Param('idOrSlug') idOrSlug: string,
    @Query('format') format: AssetExportFormat = 'json',
  ) {
    if (!['json', 'react', 'css', 'html', 'registry', 'ai'].includes(format)) {
      throw new BadRequestException('不支持的导出格式');
    }
    return this.designAssetService.exportAsset(idOrSlug, format);
  }

  @Post('assets/:id/favorite')
  toggleAssetFavorite(@Param('id') id: string) {
    return this.designAssetService.toggleFavorite(id);
  }

  @Delete('assets/:id')
  archiveAsset(@Param('id') id: string) {
    return this.designAssetService.archive(id);
  }

  @Post('studio/sessions')
  createStudioSession(@Body() dto: CreateStudioSessionDto) {
    return this.designStudioService.createSession(dto.assetId);
  }

  @Get('studio/sessions')
  listStudioSessions(@Query('assetId') assetId?: string) {
    if (!assetId) throw new BadRequestException('缺少 assetId');
    return this.designStudioService.listSessions(assetId);
  }

  @Get('studio/sessions/:id')
  getStudioSession(@Param('id') id: string) {
    return this.designStudioService.getSession(id);
  }

  @Post('studio/sessions/:id/close')
  closeStudioSession(@Param('id') id: string) {
    return this.designStudioService.closeSession(id);
  }

  @Get('studio/sessions/:id/snapshots')
  listStudioSnapshots(@Param('id') id: string) {
    return this.designStudioService.listSnapshots(id);
  }

  @Post('studio/sessions/:id/snapshots/:revision/restore')
  restoreStudioSnapshot(
    @Param('id') id: string,
    @Param('revision') revision: string,
  ) {
    return this.designStudioService.restoreSnapshot(id, Number(revision));
  }

  @Post('studio/sessions/:id/messages')
  sendStudioMessage(@Param('id') id: string, @Body() dto: SendStudioMessageDto) {
    return this.designStudioService.sendMessage(id, dto.content);
  }

  @Post('studio/sessions/:id/messages/stream')
  async streamStudioMessage(
    @Param('id') id: string,
    @Body() dto: SendStudioMessageDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);
    req.on('aborted', onClose);
    res.on('close', onClose);
    const send = (event: string, data: unknown) => {
      if (controller.signal.aborted) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await this.designStudioService.streamMessage(
        id,
        dto.content,
        send,
        controller.signal,
      );
    } catch (error) {
      send('error', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      req.off('close', onClose);
      req.off('aborted', onClose);
      res.off('close', onClose);
      res.end();
    }
  }

  @Post('studio/sessions/:id/messages/retry/stream')
  async retryStudioMessage(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);
    req.on('aborted', onClose);
    res.on('close', onClose);
    const send = (event: string, data: unknown) => {
      if (controller.signal.aborted) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      await this.designStudioService.retryMessage(id, send, controller.signal);
    } catch (error) {
      send('error', {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      req.off('close', onClose);
      req.off('aborted', onClose);
      res.off('close', onClose);
      res.end();
    }
  }

  @Post('studio/sessions/:id/discard')
  discardStudioSession(@Param('id') id: string) {
    return this.designStudioService.discardSession(id);
  }

  @Get('studio/sessions/:id/preview')
  previewStudioSession(@Param('id') id: string) {
    return this.designStudioService.previewSession(id);
  }

  @Post('studio/sessions/:id/save')
  saveStudioSession(@Param('id') id: string, @Body() dto: SaveStudioSessionDto) {
    return this.designStudioService.saveSession(
      id,
      dto.summary,
      dto.files as unknown as PreviewFile[] | undefined,
    );
  }

  @Post('studio/candidates/:id/apply')
  applyStudioCandidate(@Param('id') id: string) {
    return this.designStudioService.applyCandidate(id);
  }

  @Post('studio/candidates/:id/reject')
  rejectStudioCandidate(@Param('id') id: string) {
    return this.designStudioService.rejectCandidate(id);
  }

  @Post('studio/sessions/:id/undo')
  undoStudioSession(@Param('id') id: string) {
    return this.designStudioService.undoSession(id);
  }

  @Get('preview/sample')
  getPreviewSample() {
    return this.previewCompile.compileSample();
  }

  @Get('preview/sample/snapshot')
  async getPreviewSampleSnapshot(
    @Query('viewport') viewport: PreviewViewport = 'desktop',
    @Query('state') state: PreviewState = 'default',
    @Res() res: Response,
  ) {
    if (!['desktop', 'tablet', 'mobile'].includes(viewport)) {
      throw new BadRequestException('viewport 必须是 desktop / tablet / mobile');
    }
    if (!['default', 'hover'].includes(state)) {
      throw new BadRequestException('state 必须是 default / hover');
    }
    const result = await this.previewCompile.compileSample();
    const png = await this.previewSnapshot.capture(result.html, viewport, state);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  }

  @Get('documents')
  listDocuments(@Query('kind') kind?: string) {
    return this.designService.listDocuments(kind);
  }

  @Get('published/search')
  async searchPublished(
    @Headers('x-aurum-design-key') key: string | undefined,
    @Headers('x-client-id') clientId: string | undefined,
    @Query('q') query?: string,
    @Query('kind') kind?: string,
  ) {
    this.requireReadKey(key);
    const result = await this.designService.searchPublished(query, kind);
    await this.designService.recordReadAccess(
      undefined,
      'published/search',
      'rest_search',
      key,
      clientId,
    );
    return result;
  }

  @Get('published/:idOrSlug')
  async getPublishedAsset(
    @Headers('x-aurum-design-key') key: string | undefined,
    @Headers('x-client-id') clientId: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
  ) {
    this.requireReadKey(key);
    const asset = await this.designService.getPublishedAsset(idOrSlug);
    await this.designService.recordReadAccess(
      asset.document.id,
      'published/get',
      'rest_get',
      key,
      clientId,
    );
    return asset;
  }

  @Get('published/:idOrSlug/export')
  async exportPublishedAsset(
    @Headers('x-aurum-design-key') key: string | undefined,
    @Headers('x-client-id') clientId: string | undefined,
    @Param('idOrSlug') idOrSlug: string,
    @Query('format') format: ExportFormat = 'json',
  ) {
    this.requireReadKey(key);
    const asset = await this.designService.getPublishedAsset(idOrSlug);
    await this.designService.recordReadAccess(
      asset.document.id,
      `published/export/${format}`,
      'rest_export',
      key,
      clientId,
    );
    return this.designService.exportPublishedAsset(idOrSlug, format);
  }

  @Get('ai-tools')
  async getReadonlyToolManifest(@Headers('x-aurum-design-key') key: string | undefined) {
    this.requireReadKey(key);
    await this.designService.recordReadAccess(
      undefined,
      'ai-tools',
      'tool_manifest',
      key,
      undefined,
    );
    return this.designService.getReadonlyToolManifest();
  }

  @Post('mcp')
  async mcp(
    @Headers('x-aurum-design-key') key: string | undefined,
    @Body()
    request: {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
      id?: string | number | null;
    },
  ) {
    this.requireReadKey(key);
    await this.designService.recordReadAccess(undefined, 'mcp', 'mcp', key, undefined);
    return this.designService.handleMcpRequest(request);
  }

  private requireReadKey(key: string | undefined) {
    const expected = process.env.DESIGN_READ_API_KEY;
    if (!expected && process.env.NODE_ENV === 'production')
      throw new UnauthorizedException('DESIGN_READ_API_KEY is required in production');
    if (expected && (!key || !safeEqual(key, expected)))
      throw new UnauthorizedException('Invalid design read key');
  }

  @Post('documents')
  createDocument(@Body() dto: CreateDesignDocumentDto) {
    return this.designService.createDocument(dto);
  }

  /** 效果配方清单。创建向导用它渲染"试试这些"芯片。 */
  @Get('recipes')
  listRecipes() {
    return this.designService.listRecipes();
  }

  /** 从现成效果起手：不花 AI 调用，且成品质量由配方测试预先保证。 */
  @Post('compose/recipe')
  composeRecipe(@Body() dto: ComposeRecipeDto) {
    return this.designService.composeRecipe(dto);
  }

  /**
   * 对话生成：让 AI 出几个方案。走任务队列（方案 §15.3），结果不落库——
   * 它是提案，不是资产；选中的那一份再经 `compose/publish` 走完整发布链。
   */
  @Post('compose/generate')
  composeGenerate(@Body() dto: ComposeGenerateDto) {
    return this.designService.composeGenerate(dto);
  }

  /**
   * 一句话生成：不传类别，模型自己判断是配色、组件还是动效。
   * 与 `compose/generate` 共用任务表与修复链，产物仍在任务 result 里。
   */
  @Post('compose/auto')
  composeAuto(@Body() dto: ComposeAutoDto) {
    return this.designService.composeAuto(dto);
  }

  /**
   * 创建向导的实时编译：内容 + 控件编辑 → CSS/HTML 骨架 + 门禁结论 + 反推控件。
   *
   * 不落库、不花 AI 调用、不开浏览器，所以滑块每动一下都能调。
   */
  @Post('compose/preview')
  composePreview(@Body() dto: ComposePreviewDto) {
    return this.designService.composePreview(dto);
  }

  /**
   * 一键保存并发布。门禁在请求线程里同步预检，不通过就一个字都不写库；
   * 通过则建文档、记录候选，并把「渲染 → 选择 → 发布」交给 Worker。
   */
  @Post('compose/publish')
  composeAndPublish(@Body() dto: ComposePublishDto) {
    return this.designService.composeAndPublish(dto);
  }

  @Get('documents/:id')
  getDocument(@Param('id') id: string) {
    return this.designService.getDocument(id);
  }

  /**
   * 运营台内部的导出入口。
   *
   * 走内部守卫而不是只读 key：只读 key 是给外部 AI 消费方用的，浏览器不该持有它。
   * 没有这条，运营台就只能复制原始 JSON，拿不到可直接粘贴的 CSS/HTML。
   */
  @Get('documents/:id/export')
  exportDocument(@Param('id') id: string, @Query('format') format: ExportFormat = 'bundle') {
    return this.designService.exportPublishedAsset(id, format);
  }

  @Post('documents/:id/drafts')
  createDraft(@Param('id') id: string) {
    return this.designService.createDraft(id);
  }

  @Post('documents/:id/reference-draft')
  createReferenceDraft(
    @Param('id') id: string,
    @Body('profile') profile: Record<string, unknown>,
    @Body('source') source = 'uploaded-image',
  ) {
    return this.designService.createReferenceDraft(id, profile, source);
  }

  @Post('documents/:id/url-reference-draft')
  createUrlReferenceDraft(@Param('id') id: string, @Body() dto: CreateUrlReferenceDraftDto) {
    return this.designReferenceService.createUrlReferenceDraft(id, dto.url, dto.sourceId);
  }

  @Post('reference-sources/:id/terms-acceptance')
  acceptReferenceTerms(@Param('id') id: string, @Body() dto: AcceptReferenceTermsDto) {
    return this.designReferenceService.acceptTerms(id, dto.termsVersion, dto.acceptedBy);
  }

  @Post('drafts/:id/approve-reference')
  approveReferenceDraft(@Param('id') id: string) {
    return this.designService.approveReferenceDraft(id);
  }

  @Post('drafts/:id/candidates')
  createCandidate(@Param('id') id: string, @Body() dto: CreateCandidateDto) {
    return this.designService.createCandidate(id, dto);
  }

  @Post('drafts/:id/ai-candidates')
  queueAiCandidates(@Param('id') id: string, @Body() dto: GenerateAiCandidatesDto) {
    return this.designService.queueAiCandidates(id, dto);
  }

  @Get('drafts/:id/candidates')
  listCandidates(@Param('id') id: string) {
    return this.designService.listCandidates(id);
  }

  @Get('candidates/:id/previews')
  listCandidatePreviews(@Param('id') id: string) {
    return this.designService.listCandidatePreviews(id);
  }

  @Get('candidates/:id/previews/:viewport')
  async getCandidatePreview(
    @Param('id') id: string,
    @Param('viewport') viewport: string,
    @Query('kind') kind: 'snapshot' | 'diff' = 'snapshot',
    @Res() response: Response,
  ) {
    if (kind !== 'snapshot' && kind !== 'diff')
      throw new BadRequestException('Preview kind must be snapshot or diff');
    const path = await this.designService.getCandidatePreviewStoragePath(id, viewport, kind);
    const image = await this.storage.get(path);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.type('png').send(image);
  }

  @Post('candidates/:id/select')
  selectCandidate(@Param('id') id: string) {
    return this.designService.selectCandidate(id);
  }

  @Delete('candidates/:id')
  deleteCandidate(@Param('id') id: string) {
    return this.designService.deleteCandidate(id);
  }

  @Post('candidates/:id/render-validate')
  renderAndValidate(@Param('id') id: string) {
    return this.designService.renderAndValidateCandidate(id);
  }

  @Post('change-sets')
  createChangeSet(@Body('draftIds') draftIds: string[]) {
    return this.designService.createChangeSet(draftIds);
  }

  @Post('change-sets/:id/publish')
  publishChangeSet(@Param('id') id: string) {
    return this.designService.publishChangeSet(id);
  }

  @Get('tasks')
  listTasks(@Query('status') status?: string, @Query('draftId') draftId?: string) {
    return this.designService.listTasks({ status, draftId });
  }

  /** 单个任务。创建向导轮询生成进度用，避免拉整张任务表。 */
  @Get('tasks/:id')
  getTask(@Param('id') id: string) {
    return this.designService.getTask(id);
  }

  @Get('drafts/ready')
  listReadyDrafts() {
    return this.designService.listReadyDrafts();
  }

  @Post('tasks/:id/cancel')
  cancelTask(@Param('id') id: string) {
    return this.designService.cancelTask(id);
  }

  @Post('tasks/:id/retry')
  retryTask(@Param('id') id: string) {
    return this.designService.retryTask(id);
  }

  @Post('drafts/:id/publish')
  publishDraft(@Param('id') id: string) {
    return this.designService.publishDraft(id);
  }

  @Post('documents/:id/versions/:versionId/restore')
  restoreVersion(@Param('id') id: string, @Param('versionId') versionId: string) {
    return this.designService.restoreVersion(id, versionId);
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
