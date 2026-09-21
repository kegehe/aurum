import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { CreateCandidateDto } from './dto/create-candidate.dto';
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

@Controller('design')
@UseGuards(DesignInternalGuard)
export class DesignController {
  constructor(
    private readonly designService: DesignService,
    private readonly designReferenceService: DesignReferenceService,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
  ) {}

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
    @Query('format') format: 'json' | 'css' | 'tailwind' | 'markdown' = 'json',
  ) {
    this.requireReadKey(key);
    if (!['json', 'css', 'tailwind', 'markdown'].includes(format)) {
      throw new BadRequestException('format 必须为 json、css、tailwind 或 markdown');
    }
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

  @Get('documents/:id')
  getDocument(@Param('id') id: string) {
    return this.designService.getDocument(id);
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
  listTasks(@Query('status') status?: string) {
    return this.designService.listTasks(status);
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
