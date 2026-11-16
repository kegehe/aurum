import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { FileRole } from '../../common/constants/enums';
import { PrismaService } from '../prisma/prisma.service';
import {
  STORAGE_SERVICE,
  type IStorageService,
} from '../storage/interfaces/storage-service.interface';
import {
  PreviewCompileService,
  type PreviewManifest,
} from './preview/preview-compiler.service';
import {
  PreviewSnapshotService,
  type PreviewState,
  type PreviewViewport,
} from './preview/preview-snapshot.service';
import { PreviewRendererClient } from './preview/preview-renderer.client';

const VIEWPORT = 'desktop';
const STATE = 'default';
const KIND = 'full';

@Injectable()
export class DesignAssetSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preview: PreviewCompileService,
    private readonly snapshot: PreviewSnapshotService,
    private readonly renderer: PreviewRendererClient,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
  ) {}

  async captureVersion(
    versionId: string,
    options: { viewport?: string; state?: string; kind?: string } = {},
  ) {
    const viewport = (options.viewport ?? VIEWPORT) as PreviewViewport;
    const state = (options.state ?? STATE) as PreviewState;
    const kind = options.kind ?? KIND;
    const dimensions: Record<PreviewViewport, { width: number; height: number }> = {
      desktop: { width: 1440, height: 960 },
      tablet: { width: 1024, height: 900 },
      mobile: { width: 390, height: 844 },
    };
    const size = dimensions[viewport];
    if (!size) throw new BadRequestException(`未知视口：${viewport}`);
    if (state !== 'default' && state !== 'hover') {
      throw new BadRequestException(`未知状态：${state}`);
    }
    const version = await this.prisma.designVersion.findUnique({
      where: { id: versionId },
      include: { files: true, document: true },
    });
    if (!version) throw new NotFoundException(`设计版本 ${versionId} 不存在`);
    const manifest = this.parseManifest(version.content);
    const files = version.files.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
    const compiled = this.renderer.enabled
      ? await this.renderer.compile(manifest, files)
      : await this.preview.compile({ manifest, files });
    const png = this.renderer.enabled
      ? await this.renderer.screenshot(compiled.html, viewport, state)
      : await this.snapshot.capture(compiled.html, viewport, state);
    const artifactHash = createHash('sha256').update(png).digest('hex');
    const storageHash = createHash('sha256')
      .update(`${versionId}:${viewport}:${state}:${kind}`)
      .digest('hex');
    const storagePath = this.storage.generateKey(
      FileRole.design_preview,
      storageHash,
      `${version.documentId}-${versionId}-${viewport}-${state}`,
      'png',
    );
    await this.storage.put(storagePath, png);

    const existing = await this.prisma.previewSnapshot.findFirst({
      where: { versionId, viewport, state, kind },
      select: { id: true },
    });
    const data = {
      viewport,
      state,
      kind,
      format: 'png',
      width: size.width,
      height: size.height,
      browser: 'playwright-chromium',
      fixtureVersion: 'aurum.asset.v1',
      artifactHash,
      storagePath,
    };
    if (existing) {
      await this.prisma.previewSnapshot.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.previewSnapshot.create({ data: { ...data, versionId } });
    }
    return { artifactHash, storagePath, width: size.width, height: size.height };
  }

  async getCover(idOrSlug: string): Promise<Buffer | null> {
    const document = await this.prisma.designDocument.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        currentPublishedVersion: true,
        versions: { orderBy: { versionNumber: 'desc' }, take: 1 },
      },
    });
    if (!document) return null;
    const version = document.currentPublishedVersion ?? document.versions[0];
    if (!version) return null;
    const snapshot = await this.prisma.previewSnapshot.findFirst({
      where: {
        versionId: version.id,
        viewport: VIEWPORT,
        state: STATE,
        kind: KIND,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!snapshot?.storagePath) return null;
    try {
      return await this.storage.get(snapshot.storagePath);
    } catch {
      return null;
    }
  }

  private parseManifest(content: string): PreviewManifest {
    try {
      const parsed = JSON.parse(content) as PreviewManifest;
      if (parsed?.schemaVersion === 'aurum.asset.v1') return parsed;
    } catch {
      // fall through
    }
    throw new BadRequestException('资产版本内容不是合法资产包 manifest');
  }
}
