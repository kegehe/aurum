import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  canonicalJson,
  contentHash,
  createDependencies,
  normalizeComponentStateVariants,
  parseContent,
} from './design-content';
import { collectWithFixtureDependencies } from './design-css';
import { buildBundle, buildTokenCss } from './design-export';
import {
  attachPinnedDependencies,
  buildStaticPreviewHtml,
  extractDesignPalette,
  pinnedContents,
  pinnedVersionIds,
  type DesignPalette,
} from './design-palette';
import { getPinnedDependencies, validateDesignContent } from './design-schema';
import { checkTokenContrast } from './design-token-contrast';
import type { DesignKind, JsonRecord } from './design.types';
import { DesignAgentService } from './design-agent.service';
import { PreviewSnapshotJobService } from './preview/preview-snapshot-job.service';
import { DesignAssetSnapshotService } from './design-asset-snapshot.service';
import {
  PreviewCompileService,
  type PreviewFile,
  type PreviewManifest,
} from './preview/preview-compiler.service';
import { SAMPLE_PREVIEW_FILES, SAMPLE_PREVIEW_MANIFEST } from './preview/preview-sample';

export type AssetExportFormat = 'json' | 'react' | 'css' | 'html' | 'registry' | 'ai';

/** 版本历史只展示最近 N 个；列表不再是无限增长的整表读回 */
const VERSION_LIST_LIMIT = 100;

export interface AssetListQuery {
  kind?: string;
  subtype?: string;
  tag?: string;
  q?: string;
  status?: string;
  favorite?: string;
  sort?: string;
  cursor?: string;
  limit?: string;
}

export interface AssetFileDto {
  path: string;
  target?: string | null;
  type: string;
  language: string;
  content: string;
}

export interface AssetDetailDto {
  id: string;
  slug: string;
  name: string;
  kind: string;
  subtype: string | null;
  description: string | null;
  whenToUse: string | null;
  format: string;
  status: string;
  favorite: boolean;
  tags: string[];
  hasCover: boolean;
  coverStatus: 'pending' | 'running' | 'succeeded' | 'failed' | null;
  coverError: string | null;
  palette: string[];
  states: string[];
  tokens: string[];
  version: {
    id: string;
    versionNumber: number;
    publishedAt: Date | null;
    contentHash: string;
  } | null;
  manifest: PreviewManifest | null;
  content: Record<string, unknown> | null;
  files: AssetFileDto[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AssetSummaryDto {
  id: string;
  slug: string;
  name: string;
  kind: string;
  subtype: string | null;
  description: string | null;
  format: string;
  status: string;
  favorite: boolean;
  tags: string[];
  hasCover: boolean;
  coverStatus: 'pending' | 'running' | 'succeeded' | 'failed' | null;
  coverError: string | null;
  palette: string[];
  states: string[];
  tokens: string[];
  version: {
    id: string;
    versionNumber: number;
    publishedAt: Date | null;
  } | null;
  updatedAt: Date;
}

@Injectable()
export class DesignAssetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly preview: PreviewCompileService,
    private readonly snapshots: DesignAssetSnapshotService,
    private readonly agent: DesignAgentService,
    private readonly jobs: PreviewSnapshotJobService,
  ) {}

  async create(input: {
    manifest: PreviewManifest;
    files: PreviewFile[];
    publish?: boolean;
    tags?: string[];
  }): Promise<AssetDetailDto> {
    if (!input?.manifest || !Array.isArray(input.files)) {
      throw new BadRequestException('资产必须包含 manifest 和 files');
    }
    const manifest = input.manifest;
    this.validateManifest(manifest);
    const files = input.files.map((file) => this.normalizeFile(file));
    this.validateFiles(manifest, files);
    const existing = await this.prisma.designDocument.findUnique({
      where: { slug: manifest.slug },
      select: { id: true },
    });
    if (existing) throw new ConflictException(`资产 slug 已存在：${manifest.slug}`);
    await this.preview.compile({ manifest, files });

    const tags = this.normalizeTags([...(input.tags ?? []), ...(manifest.tags ?? [])]);
    const publish = input.publish !== false;
    const hash = contentHash(
      canonicalJson({
        manifest,
        files: [...files]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((file) => ({ path: file.path, content: file.content })),
      }),
    );

    let document;
    try {
      document = await this.prisma.$transaction(async (tx) => {
      const created = await tx.designDocument.create({
        data: {
          slug: manifest.slug,
          name: manifest.name,
          kind: manifest.kind,
          format: 'package',
          subtype: manifest.subtype,
          description: manifest.description,
          whenToUse: manifest.whenToUse,
          source: manifest.source ?? 'manual',
          status: 'draft',
        },
      });

      const version = await tx.designVersion.create({
        data: {
          documentId: created.id,
          versionNumber: 1,
          format: 'package',
          content: canonicalJson(manifest),
          contentHash: hash,
          summary: '初始版本',
          changeKind: 'create',
          publishedAt: publish ? new Date() : null,
        },
      });
      await this.jobs.enqueue(tx, version.id);

      await tx.designAssetFile.createMany({
        data: files.map((file) => ({
          versionId: version.id,
          path: file.path,
          target: file.target ?? null,
          type: file.type ?? this.inferType(file.path),
          language: file.language ?? this.inferLanguage(file.path),
          content: file.content,
        })),
      });

      for (const tag of tags) {
        const saved = await tx.designAssetTag.upsert({
          where: { slug: tag.slug },
          update: {},
          create: { name: tag.name, slug: tag.slug },
        });
        await tx.designAssetTagLink.create({
          data: { documentId: created.id, tagId: saved.id },
        });
      }

      return tx.designDocument.update({
        where: { id: created.id },
        data: {
          // 未发布版本不能成为“当前发布版”，否则 get/导出会拿到草稿。
          ...(publish ? { currentPublishedVersionId: version.id } : {}),
          status: publish ? 'published' : 'draft',
        },
      });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`资产 slug 或标签冲突：${manifest.slug}`);
      }
      throw error;
    }

    // 封面是增强信息：创建接口不阻塞在 Playwright 上；详情页可点「生成封面」。
    return this.get(document.id);
  }

  async list(query: AssetListQuery) {
    const take = Math.min(Math.max(Number(query.limit) || 24, 1), 50);
    const status = query.status ?? 'published';
    const where: Prisma.DesignDocumentWhereInput = {
      ...(status !== 'all' ? { status } : {}),
      ...(query.kind === 'theme'
        ? { kind: { in: ['theme', 'foundation', 'style_pack'] } }
        : query.kind
          ? { kind: query.kind }
          : {}),
      ...(query.subtype ? { subtype: query.subtype } : {}),
      ...(query.favorite === 'true' ? { favorite: true } : {}),
      ...(query.tag ? { tags: { some: { tag: { slug: query.tag } } } } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q } },
              { slug: { contains: query.q } },
              { description: { contains: query.q } },
              { tags: { some: { tag: { name: { contains: query.q } } } } },
            ],
          }
        : {}),
    };

    // 末尾必须带唯一键 id 兜底：游标分页按 id 定位，若排序键（name/updatedAt）出现并列，
    // Prisma 在非唯一排序上做严格比较会跳过与上一页末项并列的行，导致「加载更多」丢数据。
    const orderBy: Prisma.DesignDocumentOrderByWithRelationInput[] =
      query.sort === 'name'
        ? [{ name: 'asc' }, { id: 'asc' }]
        : query.sort === 'favorite'
          ? [{ favorite: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }]
          : [{ updatedAt: 'desc' }, { id: 'asc' }];

    const documents = await this.prisma.designDocument.findMany({
      where,
      orderBy,
      take,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: {
        currentPublishedVersion: {
          include: {
            previewSnapshots: {
              where: { viewport: 'desktop', state: 'default', kind: 'full' },
              select: { id: true },
              take: 1,
            },
            previewSnapshotJobs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, error: true },
            },
          },
        },
        tags: { include: { tag: true } },
      },
    });
    const palettes = await this.palettesFor(
      documents.flatMap((document) =>
        document.currentPublishedVersion
          ? [
              {
                id: document.currentPublishedVersion.id,
                content: document.currentPublishedVersion.content,
                format: document.format,
              },
            ]
          : [],
      ),
    );

    return {
      items: documents.map((document) =>
        this.toSummary(
          document,
          document.currentPublishedVersion
            ? palettes.get(document.currentPublishedVersion.id)
            : undefined,
        ),
      ),
      nextCursor: documents.length === take ? documents[documents.length - 1]?.id ?? null : null,
    };
  }

  async get(idOrSlug: string): Promise<AssetDetailDto> {
    const document = await this.prisma.designDocument.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        currentPublishedVersion: {
          include: {
            files: true,
            previewSnapshots: {
              where: { viewport: 'desktop', state: 'default', kind: 'full' },
              select: { id: true },
              take: 1,
            },
            previewSnapshotJobs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, error: true },
            },
          },
        },
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: {
            files: true,
            previewSnapshots: {
              where: { viewport: 'desktop', state: 'default', kind: 'full' },
              select: { id: true },
              take: 1,
            },
            previewSnapshotJobs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { status: true, error: true },
            },
          },
        },
        tags: { include: { tag: true } },
      },
    });
    if (!document) throw new NotFoundException(`设计资产 ${idOrSlug} 不存在`);
    const version = document.currentPublishedVersion ?? document.versions[0];
    if (!version) throw new NotFoundException(`设计资产 ${idOrSlug} 还没有版本`);
    const manifest =
      document.format === 'package' ? this.parseManifest(version.content) : null;
    const content =
      document.format === 'package' ? null : this.tryParseJson(version.content);
    const extracted = await this.paletteFor(version.content, document.format);
    return {
      id: document.id,
      slug: document.slug,
      name: document.name,
      kind: document.kind,
      subtype: document.subtype,
      description: document.description,
      whenToUse: document.whenToUse,
      format: document.format,
      status: document.status,
      favorite: document.favorite,
      tags: document.tags.map((link) => link.tag.name),
      hasCover: (version.previewSnapshots?.length ?? 0) > 0,
      coverStatus:
        (version.previewSnapshotJobs?.[0]?.status as
          | 'pending'
          | 'running'
          | 'succeeded'
          | 'failed'
          | undefined) ?? null,
      coverError: version.previewSnapshotJobs?.[0]?.error ?? null,
      palette: extracted.colors,
      states: manifest?.states ?? [],
      tokens: manifest?.tokens?.length ? manifest.tokens : extracted.tokens,
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        publishedAt: version.publishedAt,
        contentHash: version.contentHash,
      },
      manifest,
      content,
      files: version.files.map((file) => ({
        path: file.path,
        target: file.target,
        type: file.type,
        language: file.language,
        content: file.content,
      })),
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  async saveVersion(
    idOrSlug: string,
    input: {
      files: PreviewFile[];
      summary?: string;
      publish?: boolean;
      /**
       * 调用方看到的正式版本。设置后，只有正式版本指针仍指向它才允许落库，
       * 避免工作台基于旧版本保存时把别人刚发布的版本静默覆盖。
       */
      expectedBaseVersionId?: string | null;
    },
  ): Promise<AssetDetailDto> {
    if (!Array.isArray(input.files)) {
      throw new BadRequestException('保存版本必须包含 files');
    }
    const asset = await this.get(idOrSlug);
    if (asset.format !== 'package' || !asset.manifest) {
      throw new BadRequestException('只有资产包格式支持工作台保存');
    }
    const files = input.files.map((file) => this.normalizeFile(file));
    this.validateFiles(asset.manifest, files);
    await this.preview.compile({ manifest: asset.manifest, files });

    const latest = await this.prisma.designVersion.findFirst({
      where: { documentId: asset.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, contentHash: true },
    });
    if (!latest) throw new BadRequestException('资产还没有可基于的版本');
    const hash = contentHash(
      canonicalJson({
        manifest: asset.manifest,
        files: [...files]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((file) => ({ path: file.path, content: file.content })),
      }),
    );
    if (hash === latest.contentHash) return asset;

    const publish = input.publish !== false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const version = await tx.designVersion.create({
          data: {
            documentId: asset.id,
            versionNumber: latest.versionNumber + 1,
            baseVersionId: latest.id,
            format: 'package',
            content: canonicalJson(asset.manifest),
            contentHash: hash,
            summary: input.summary?.trim() || '工作台保存',
            changeKind: 'update',
            publishedAt: publish ? new Date() : null,
          },
        });
        await this.jobs.enqueue(tx, version.id);
        await tx.designAssetFile.createMany({
          data: files.map((file) => ({
            versionId: version.id,
            path: file.path,
            target: file.target ?? null,
            type: file.type ?? this.inferType(file.path),
            language: file.language ?? this.inferLanguage(file.path),
            content: file.content,
          })),
        });
        // 调用方看到的 HEAD：有正式版本时是正式版本；从未发布过时，get() 以最新版本兜底。
        // 守卫必须用同一套语义，否则未发布过的资产每次保存都会被误判为“版本已过期”。
        let guardWhere: Prisma.DesignDocumentWhereInput = { id: asset.id };
        if (publish && input.expectedBaseVersionId) {
          const head = await tx.designDocument.findUnique({
            where: { id: asset.id },
            select: {
              currentPublishedVersionId: true,
              versions: {
                orderBy: { versionNumber: 'desc' },
                take: 1,
                select: { id: true },
              },
            },
          });
          if (!head) throw new NotFoundException('资产不存在或已被删除');
          const headId = head.currentPublishedVersionId ?? head.versions[0]?.id ?? null;
          if (headId !== input.expectedBaseVersionId) {
            throw new ConflictException('正式版本已发生变化，请刷新后基于最新版本重新保存');
          }
          // 条件更新只认刚才校验过的那个 HEAD：期间有人发布，updateMany 会失配。
          guardWhere = {
            id: asset.id,
            currentPublishedVersionId: head.currentPublishedVersionId,
          };
        }
        const claimed = await tx.designDocument.updateMany({
          where: guardWhere,
          data: {
            ...(publish ? { currentPublishedVersionId: version.id } : {}),
            status: publish ? 'published' : asset.status,
          },
        });
        if (claimed.count !== 1) {
          if (publish && input.expectedBaseVersionId) {
            throw new ConflictException('正式版本已发生变化，请刷新后基于最新版本重新保存');
          }
          throw new NotFoundException('资产不存在或已被删除');
        }
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('版本号冲突，请刷新后重试');
      }
      throw error;
    }

    return this.get(asset.id);
  }

  async generateTokenPatch(
    idOrSlug: string,
    content: Record<string, unknown>,
    request: string,
  ) {
    const asset = await this.get(idOrSlug);
    if (asset.format !== 'token') {
      throw new BadRequestException('只有 Token 资产支持 AI 修改');
    }
    const current = validateDesignContent(asset.kind as DesignKind, content);
    const patch = await this.agent.generateTokenPatch({ content: current, request });
    const proposed = validateDesignContent(asset.kind as DesignKind, patch.content);
    return {
      summary: patch.summary,
      rationale: patch.rationale,
      content: proposed,
      contrast: checkTokenContrast(proposed),
    };
  }

  async checkTokenContrast(
    idOrSlug: string,
    content: Record<string, unknown>,
  ) {
    const asset = await this.get(idOrSlug);
    if (asset.format !== 'token') {
      throw new BadRequestException('只有 Token 资产支持对比度检查');
    }
    return checkTokenContrast(validateDesignContent(asset.kind as DesignKind, content));
  }

  async listTokenDependents(idOrSlug: string) {
    const token = await this.get(idOrSlug);
    if (token.format !== 'token' || !token.version) {
      throw new BadRequestException('只有 Token 资产支持依赖查询');
    }
    const documents = await this.prisma.designDocument.findMany({
      where: { id: { not: token.id }, status: 'published' },
      // 只取依赖判定与 DTO 真正用到的列：content 是唯一的大字段，其余列不再随行读回
      select: {
        id: true,
        slug: true,
        name: true,
        kind: true,
        format: true,
        currentPublishedVersion: { select: { id: true, versionNumber: true, content: true } },
      },
    });
    const dependents = documents.flatMap((document) => {
      const version = document.currentPublishedVersion;
      if (!version) return [];
      let content: Record<string, unknown>;
      try {
        content = parseContent(version.content);
      } catch {
        return [];
      }
      const dependency = getPinnedDependencies(content).find(
        (item: { documentId: string; versionId: string }) => item.documentId === token.id,
      );
      if (!dependency) return [];
      return [
        {
          documentId: document.id,
          slug: document.slug,
          name: document.name,
          kind: document.kind,
          format: document.format,
          versionId: version.id,
          versionNumber: version.versionNumber,
          pinnedVersionId: dependency.versionId,
          outdated: dependency.versionId !== token.version!.id,
        },
      ];
    });
    return {
      token: {
        id: token.id,
        slug: token.slug,
        name: token.name,
        versionId: token.version.id,
        versionNumber: token.version.versionNumber,
      },
      dependents,
    };
  }

  async rebuildTokenDependents(
    idOrSlug: string,
    documentIds?: string[],
  ) {
    const token = await this.get(idOrSlug);
    if (token.format !== 'token' || !token.version) {
      throw new BadRequestException('只有 Token 资产支持依赖重建');
    }
    const documents = await this.prisma.designDocument.findMany({
      where: {
        status: 'published',
        id: { not: token.id, ...(documentIds?.length ? { in: documentIds } : {}) },
      },
      select: {
        id: true,
        slug: true,
        name: true,
        kind: true,
        format: true,
        currentPublishedVersion: { select: { id: true, versionNumber: true, content: true } },
      },
    });
    const results: Array<{
      documentId: string;
      slug: string;
      status: 'updated' | 'skipped';
      versionNumber?: number;
      error?: string;
    }> = [];
    for (const document of documents) {
      const version = document.currentPublishedVersion;
      if (!version) {
        results.push({ documentId: document.id, slug: document.slug, status: 'skipped', error: '没有正式版本' });
        continue;
      }
      let content: Record<string, unknown>;
      try {
        content = parseContent(version.content);
      } catch (error) {
        results.push({
          documentId: document.id,
          slug: document.slug,
          status: 'skipped',
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const dependencies = getPinnedDependencies(content);
      const index = dependencies.findIndex(
        (item: { documentId: string; versionId: string }) => item.documentId === token.id,
      );
      if (index < 0) {
        results.push({ documentId: document.id, slug: document.slug, status: 'skipped', error: '不依赖该 Token' });
        continue;
      }
      if (dependencies[index].versionId === token.version.id) {
        results.push({ documentId: document.id, slug: document.slug, status: 'skipped', error: '已使用当前 Token 版本' });
        continue;
      }
      const rawDependencies = content.dependencies;
      if (!Array.isArray(rawDependencies)) {
        results.push({ documentId: document.id, slug: document.slug, status: 'skipped', error: 'dependencies 结构无法更新' });
        continue;
      }
      const nextContent = {
        ...content,
        dependencies: rawDependencies.map((item: unknown) =>
          item &&
          typeof item === 'object' &&
          (item as { documentId?: unknown }).documentId === token.id
            ? { ...(item as Record<string, unknown>), versionId: token.version!.id }
            : item,
        ),
      };
      try {
        const validated = validateDesignContent(document.kind as DesignKind, nextContent);
        const encoded = canonicalJson(validated);
        const hash = contentHash(encoded);
        const nextVersion = await this.prisma.$transaction(async (tx) => {
          const created = await tx.designVersion.create({
            data: {
              documentId: document.id,
              versionNumber: version.versionNumber + 1,
              baseVersionId: version.id,
              format: document.format,
              content: encoded,
              contentHash: hash,
              summary: `同步 Token ${token.name} v${token.version!.versionNumber}`,
              changeKind: 'update',
              publishedAt: new Date(),
            },
          });
          await createDependencies(tx, validated, document.id, created.id);
          await tx.designDocument.update({
            where: { id: document.id },
            data: { currentPublishedVersionId: created.id, status: 'published' },
          });
          return created;
        });
        results.push({
          documentId: document.id,
          slug: document.slug,
          status: 'updated',
          versionNumber: nextVersion.versionNumber,
        });
      } catch (error) {
        results.push({
          documentId: document.id,
          slug: document.slug,
          status: 'skipped',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      updated: results.filter((item) => item.status === 'updated').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      results,
    };
  }

  async saveTokenVersion(
    idOrSlug: string,
    input: { content: Record<string, unknown>; summary?: string },
  ): Promise<AssetDetailDto> {
    const asset = await this.get(idOrSlug);
    if (asset.format !== 'token') {
      throw new BadRequestException('只有 Token 资产支持此保存接口');
    }
    const content = validateDesignContent(asset.kind as DesignKind, input.content);
    const contrast = checkTokenContrast(content);
    if (contrast.status === 'fail') {
      const failed = contrast.checks
        .filter((check) => check.verdict.status === 'fail')
        .map((check) => check.name)
        .join('、');
      throw new BadRequestException(`Token 对比度不足：${failed}`);
    }
    const encoded = canonicalJson(content);
    const hash = contentHash(encoded);
    const latest = await this.prisma.designVersion.findFirst({
      where: { documentId: asset.id },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, contentHash: true },
    });
    if (!latest) throw new BadRequestException('Token 资产还没有可基于的版本');
    if (hash === latest.contentHash) return asset;
    try {
      await this.prisma.$transaction(async (tx) => {
        const version = await tx.designVersion.create({
          data: {
            documentId: asset.id,
            versionNumber: latest.versionNumber + 1,
            baseVersionId: latest.id,
            format: 'token',
            content: encoded,
            contentHash: hash,
            summary: input.summary?.trim() || 'Token 编辑',
            changeKind: 'update',
            publishedAt: new Date(),
          },
        });
        await tx.designDocument.update({
          where: { id: asset.id },
          data: { currentPublishedVersionId: version.id, status: 'published' },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Token 版本号冲突，请刷新后重试');
      }
      throw error;
    }
    return this.get(asset.id);
  }

  async listVersions(idOrSlug: string) {
    const document = await this.prisma.designDocument.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true },
    });
    if (!document) throw new NotFoundException(`设计资产 ${idOrSlug} 不存在`);
    const versions = await this.prisma.designVersion.findMany({
      where: { documentId: document.id },
      orderBy: { versionNumber: 'desc' },
      // 版本列表只用于「最近版本」展示与回滚，加硬上限避免单文档版本无限增长后整表读回
      take: VERSION_LIST_LIMIT,
      include: { _count: { select: { files: true } } },
    });
    return {
      items: versions.map((version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        format: version.format,
        summary: version.summary,
        contentHash: version.contentHash,
        publishedAt: version.publishedAt,
        createdAt: version.createdAt,
        fileCount: version._count.files,
      })),
    };
  }

  async getVersion(idOrSlug: string, versionId: string) {
    const document = await this.prisma.designDocument.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true, slug: true, name: true },
    });
    if (!document) throw new NotFoundException(`设计资产 ${idOrSlug} 不存在`);
    const version = await this.prisma.designVersion.findFirst({
      where: { id: versionId, documentId: document.id },
      include: { files: true },
    });
    if (!version) throw new NotFoundException(`版本 ${versionId} 不存在`);
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      format: version.format,
      summary: version.summary,
      contentHash: version.contentHash,
      publishedAt: version.publishedAt,
      createdAt: version.createdAt,
      manifest: version.format === 'package' ? this.parseManifest(version.content) : null,
      content: version.format === 'package' ? null : this.tryParseJson(version.content),
      files: version.files.map((file) => ({
        path: file.path,
        target: file.target,
        type: file.type,
        language: file.language,
        content: file.content,
      })),
    };
  }

  async diffVersions(idOrSlug: string, versionId: string, againstVersionId: string) {
    const document = await this.prisma.designDocument.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      select: { id: true },
    });
    if (!document) throw new NotFoundException(`设计资产 ${idOrSlug} 不存在`);
    const [current, base] = await Promise.all([
      this.prisma.designVersion.findFirst({
        where: { id: versionId, documentId: document.id },
        include: { files: true },
      }),
      this.prisma.designVersion.findFirst({
        where: { id: againstVersionId, documentId: document.id },
        include: { files: true },
      }),
    ]);
    if (!current || !base) throw new NotFoundException('要对比的版本不存在');
    const baseFiles = new Map(base.files.map((file) => [file.path, file.content]));
    const currentFiles = new Map(current.files.map((file) => [file.path, file.content]));
    const paths = new Set([...baseFiles.keys(), ...currentFiles.keys()]);
    const files: Array<{
      path: string;
      status: 'added' | 'removed' | 'changed' | 'unchanged';
      before?: string;
      after?: string;
    }> = [];
    if (paths.size === 0 && base.content !== current.content) {
      files.push({
        path: 'content.json',
        status: 'changed',
        before: base.content,
        after: current.content,
      });
    }
    for (const path of [...paths].sort()) {
      const before = baseFiles.get(path);
      const after = currentFiles.get(path);
      if (before === undefined) {
        files.push({ path, status: 'added', after });
      } else if (after === undefined) {
        files.push({ path, status: 'removed', before });
      } else if (before !== after) {
        files.push({ path, status: 'changed', before, after });
      } else {
        files.push({ path, status: 'unchanged', before, after });
      }
    }
    return {
      from: {
        id: base.id,
        versionNumber: base.versionNumber,
        contentHash: base.contentHash,
      },
      to: {
        id: current.id,
        versionNumber: current.versionNumber,
        contentHash: current.contentHash,
      },
      summary: {
        added: files.filter((file) => file.status === 'added').length,
        removed: files.filter((file) => file.status === 'removed').length,
        changed: files.filter((file) => file.status === 'changed').length,
      },
      files,
    };
  }

  async previewAsset(idOrSlug: string) {
    const asset = await this.get(idOrSlug);
    if (asset.format === 'package' && asset.manifest) {
      return this.preview.compile({
        manifest: asset.manifest,
        files: this.toPreviewFiles(asset.files),
      });
    }
    if (asset.format === 'token' && (asset.kind === 'component' || asset.kind === 'animation')) {
      const bundle = await this.renderDesignBundle(asset.kind, asset.content ?? {});
      const css = bundle.copyCss || bundle.css;
      return {
        html: buildStaticPreviewHtml(css, bundle.html),
        fragment: bundle.html,
        css,
        js: '',
        classes: [] as string[],
        contentHash: asset.version?.contentHash ?? '',
        cssBytes: Buffer.byteLength(css),
        jsBytes: 0,
      };
    }
    throw new BadRequestException('这个资产没有可渲染的预览');
  }

  async getCover(idOrSlug: string) {
    return this.snapshots.getCover(idOrSlug);
  }

  async captureSnapshot(idOrSlug: string) {
    const asset = await this.get(idOrSlug);
    if (asset.format !== 'package') {
      throw new BadRequestException('只有资产包支持封面生成');
    }
    if (!asset.version) throw new BadRequestException('资产还没有版本');
    await this.jobs.enqueueForVersion(asset.version.id);
    return this.get(idOrSlug);
  }

  async exportAsset(idOrSlug: string, format: AssetExportFormat = 'json') {
    const asset = await this.get(idOrSlug);
    if (format === 'json') {
      return {
        format,
        content: asset.format === 'package' ? asset.manifest : asset.content,
        files: asset.files,
      };
    }
    if (asset.format === 'token') {
      if (format === 'css') {
        const content = asset.content ?? {};
        if (asset.kind === 'component' || asset.kind === 'animation') {
          const bundle = await this.renderDesignBundle(asset.kind, content);
          return {
            format,
            css: bundle.copyCss || bundle.css,
            skipped: bundle.skippedTokens,
            collisions: [] as string[],
          };
        }
        const resolved = await this.resolveDesignContent(content);
        const result = buildTokenCss([resolved, ...pinnedContents(resolved)], {
          selector: '.aurum-preview',
        });
        return {
          format,
          css: result.css,
          skipped: result.skipped,
          collisions: result.collisions,
        };
      }
      if (format === 'ai') {
        return { format, markdown: this.toTokenAiMarkdown(asset) };
      }
      throw new BadRequestException('Token 资产只支持 json / css / ai 导出');
    }
    if (asset.format === 'legacy') {
      if (format === 'ai') {
        return { format, markdown: this.toLegacyAiMarkdown(asset) };
      }
      throw new BadRequestException('旧格式资产目前只支持 json / ai 导出');
    }
    const manifest = asset.manifest;
    if (!manifest) throw new BadRequestException('资产包缺少 manifest');
    if (format === 'react') {
      const deliverable = asset.files.filter((file) =>
        manifest.files.some((item) => item.path === file.path),
      );
      return {
        format,
        files: deliverable.map((file) => ({
          path: file.target ?? file.path,
          content: file.content,
          type: file.type,
          language: file.language,
        })),
        dependencies: manifest.dependencies ?? [],
        registryDependencies: manifest.registryDependencies ?? [],
        install: 'npx shadcn@latest add <registry-url>',
      };
    }
    if (format === 'registry') {
      const deliverable = asset.files.filter((file) =>
        manifest.files.some((item) => item.path === file.path),
      );
      return {
        format,
        registry: {
          name: asset.slug,
          type: asset.kind === 'layout' ? 'registry:block' : 'registry:ui',
          dependencies: manifest.dependencies ?? [],
          registryDependencies: manifest.registryDependencies ?? [],
          files: deliverable.map((file) => ({
            path: file.target ?? file.path,
            content: file.content,
            type: file.type,
          })),
          cssVars: {},
        },
        install: 'npx shadcn@latest add <registry-url>',
      };
    }
    if (format === 'ai') {
      return { format, markdown: this.toAiMarkdown(asset) };
    }
    const compiled = await this.previewAsset(idOrSlug);
    if (format === 'css') return { format, css: compiled.css, classes: compiled.classes };
    if (format === 'html') return { format, html: compiled.html };
    throw new BadRequestException(`不支持的导出格式：${format}`);
  }

  async toggleFavorite(id: string) {
    const document = await this.prisma.designDocument.findUnique({
      where: { id },
      select: { id: true, favorite: true },
    });
    if (!document) throw new NotFoundException(`设计资产 ${id} 不存在`);
    await this.prisma.designDocument.update({
      where: { id },
      data: { favorite: !document.favorite },
    });
    return this.get(id);
  }

  async archive(id: string) {
    const document = await this.prisma.designDocument.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!document) throw new NotFoundException(`设计资产 ${id} 不存在`);
    await this.prisma.designDocument.update({
      where: { id },
      data: { status: 'archived' },
    });
    return { archived: true, id };
  }

  async seedSample(): Promise<AssetDetailDto> {
    const existing = await this.prisma.designDocument.findUnique({
      where: { slug: SAMPLE_PREVIEW_MANIFEST.slug },
      select: { id: true },
    });
    if (existing) {
      const detail = await this.get(existing.id);
      if (detail.version) {
        await this.jobs.enqueueForVersion(detail.version.id);
      }
      return detail;
    }
    const created = await this.create({
      manifest: SAMPLE_PREVIEW_MANIFEST,
      files: SAMPLE_PREVIEW_FILES,
      tags: ['玻璃', '按钮', '深色'],
      publish: true,
    });
    return created;
  }

  private toSummary(
    document: {
      id: string;
      slug: string;
      name: string;
      kind: string;
      subtype: string | null;
      description: string | null;
      format: string;
      status: string;
      favorite: boolean;
      updatedAt: Date;
      currentPublishedVersion: {
        id: string;
        versionNumber: number;
        publishedAt: Date | null;
        content: string;
        previewSnapshots: Array<{ id: string }>;
        previewSnapshotJobs: Array<{ status: string; error: string | null }>;
      } | null;
      tags: Array<{ tag: { name: string } }>;
    },
    extracted?: DesignPalette,
  ): AssetSummaryDto {
    const manifest = document.currentPublishedVersion
      ? this.tryParseManifest(document.currentPublishedVersion.content)
      : null;
    return {
      id: document.id,
      slug: document.slug,
      name: document.name,
      kind: document.kind,
      subtype: document.subtype,
      description: document.description,
      format: document.format,
      status: document.status,
      favorite: document.favorite,
      tags: document.tags.map((link) => link.tag.name),
      hasCover: (document.currentPublishedVersion?.previewSnapshots?.length ?? 0) > 0,
      coverStatus:
        (document.currentPublishedVersion?.previewSnapshotJobs?.[0]?.status as
          | 'pending'
          | 'running'
          | 'succeeded'
          | 'failed'
          | undefined) ?? null,
      coverError: document.currentPublishedVersion?.previewSnapshotJobs?.[0]?.error ?? null,
      palette: extracted?.colors ?? [],
      states: manifest?.states ?? [],
      tokens: manifest?.tokens?.length ? manifest.tokens : (extracted?.tokens ?? []),
      version: document.currentPublishedVersion
        ? {
            id: document.currentPublishedVersion.id,
            versionNumber: document.currentPublishedVersion.versionNumber,
            publishedAt: document.currentPublishedVersion.publishedAt,
          }
        : null,
      updatedAt: document.updatedAt,
    };
  }

  private validateManifest(manifest: PreviewManifest): void {
    if (manifest?.schemaVersion !== 'aurum.asset.v1') {
      throw new BadRequestException('manifest.schemaVersion 必须是 aurum.asset.v1');
    }
    if (
      typeof manifest.slug !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(manifest.slug)
    ) {
      throw new BadRequestException('manifest.slug 必须是小写 kebab-case');
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new BadRequestException('manifest.name 不能为空');
    }
    if (!['component', 'layout', 'animation'].includes(manifest.kind)) {
      throw new BadRequestException('manifest.kind 必须是 component / layout / animation');
    }
    if (manifest.subtype !== undefined && typeof manifest.subtype !== 'string') {
      throw new BadRequestException('manifest.subtype 必须是字符串');
    }
    for (const key of ['description', 'whenToUse'] as const) {
      if (manifest[key] !== undefined && typeof manifest[key] !== 'string') {
        throw new BadRequestException(`manifest.${key} 必须是字符串`);
      }
    }
    if (
      manifest.source !== undefined &&
      !['manual', 'ai', 'reference', 'recipe', 'import'].includes(manifest.source)
    ) {
      throw new BadRequestException('manifest.source 不在允许范围');
    }
    if (
      manifest.tags !== undefined &&
      (!Array.isArray(manifest.tags) || manifest.tags.some((tag) => typeof tag !== 'string'))
    ) {
      throw new BadRequestException('manifest.tags 必须是字符串数组');
    }
    if (!manifest.preview || typeof manifest.preview.entry !== 'string') {
      throw new BadRequestException('manifest.preview.entry 不能为空');
    }
    if (!Array.isArray(manifest.files)) throw new BadRequestException('manifest.files 必须是数组');
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string') {
        throw new BadRequestException('manifest.files 每项必须包含 path');
      }
      for (const key of ['target', 'type', 'language'] as const) {
        if (file[key] !== undefined && typeof file[key] !== 'string') {
          throw new BadRequestException(`manifest.files.${key} 必须是字符串`);
        }
      }
      if (
        file.target &&
        (file.target.startsWith('/') ||
          file.target.includes('..') ||
          file.target.includes('\\') ||
          file.target.includes(':'))
      ) {
        throw new BadRequestException(`manifest.files.target 不安全：${file.target}`);
      }
    }
  }

  private validateFiles(manifest: PreviewManifest, files: PreviewFile[]): void {
    const paths = new Set(files.map((file) => file.path));
    if (!paths.has(manifest.preview.entry)) {
      throw new BadRequestException('manifest.preview.entry 不在 files 中');
    }
    for (const file of files) {
      if (
        file.target &&
        (file.target.startsWith('/') ||
          file.target.includes('..') ||
          file.target.includes('\\') ||
          file.target.includes(':'))
      ) {
        throw new BadRequestException(`文件 target 不安全：${file.target}`);
      }
    }
    for (const file of manifest.files) {
      if (!paths.has(file.path)) {
        throw new BadRequestException(`manifest.files 引用了不存在的文件：${file.path}`);
      }
    }
  }

  private normalizeFile(file: PreviewFile): PreviewFile {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new BadRequestException('files 每项必须包含 path 和 content');
    }
    for (const key of ['target', 'type', 'language'] as const) {
      if (file[key] !== undefined && file[key] !== null && typeof file[key] !== 'string') {
        throw new BadRequestException(`files.${key} 必须是字符串`);
      }
    }
    return {
      ...file,
      target: file.target ?? undefined,
      type: file.type ?? this.inferType(file.path),
      language: file.language ?? this.inferLanguage(file.path),
    };
  }

  private inferType(path: string): string {
    if (path.startsWith('preview/') || path.includes('/preview.')) return 'asset:preview';
    if (path.includes('fixture')) return 'asset:fixture';
    if (path.endsWith('.css')) return 'registry:file';
    if (path.endsWith('.md')) return 'asset:doc';
    return 'registry:ui';
  }

  private inferLanguage(path: string): string {
    if (path.endsWith('.tsx')) return 'tsx';
    if (path.endsWith('.ts')) return 'ts';
    if (path.endsWith('.css')) return 'css';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.md')) return 'md';
    return 'text';
  }

  private normalizeTags(values: string[]): Array<{ name: string; slug: string }> {
    const seen = new Set<string>();
    const tags: Array<{ name: string; slug: string }> = [];
    for (const value of values) {
      const name = String(value ?? '').trim();
      if (!name) continue;
      const slug = name
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '');
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      tags.push({ name, slug });
    }
    return tags;
  }

  private tryParseJson(content: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(content) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private async paletteFor(content: string, format: string): Promise<DesignPalette> {
    const parsed = this.tryParseJson(content);
    if (!parsed) return { colors: [], tokens: [] };
    return extractDesignPalette(await this.resolveDesignContent(parsed), {
      scanReferences: format !== 'package',
    });
  }

  private async palettesFor(
    versions: Array<{ id: string; content: string; format: string }>,
  ): Promise<Map<string, DesignPalette>> {
    const parsed = versions.map((version) => ({
      id: version.id,
      format: version.format,
      content: this.tryParseJson(version.content),
    }));
    const loaded = await this.loadPinnedVersions(
      parsed.flatMap((version) => (version.content ? [version.content] : [])),
    );
    const result = new Map<string, DesignPalette>();
    for (const version of parsed) {
      result.set(
        version.id,
        version.content
          ? extractDesignPalette(attachPinnedDependencies(version.content, loaded), {
              scanReferences: version.format !== 'package',
            })
          : { colors: [], tokens: [] },
      );
    }
    return result;
  }

  private async resolveDesignContent(content: JsonRecord): Promise<JsonRecord> {
    return attachPinnedDependencies(content, await this.loadPinnedVersions([content]));
  }

  private async loadPinnedVersions(roots: JsonRecord[]): Promise<Map<string, JsonRecord>> {
    const loaded = new Map<string, JsonRecord>();
    const attempted = new Set<string>();
    let frontier = this.pendingPinIds(roots, loaded, attempted);
    for (let depth = 0; depth < 4 && frontier.length > 0; depth += 1) {
      for (const id of frontier) attempted.add(id);
      const versions = await this.prisma.designVersion.findMany({
        where: { id: { in: frontier } },
        select: { id: true, content: true },
      });
      const parsed: JsonRecord[] = [];
      for (const version of versions) {
        const content = this.tryParseJson(version.content);
        if (!content) continue;
        loaded.set(version.id, content);
        parsed.push(content);
      }
      frontier = this.pendingPinIds(parsed, loaded, attempted);
    }
    return loaded;
  }

  private pendingPinIds(
    contents: JsonRecord[],
    loaded: Map<string, JsonRecord>,
    attempted: Set<string>,
  ): string[] {
    const ids = new Set<string>();
    for (const content of contents) {
      for (const id of pinnedVersionIds(content)) {
        if (!loaded.has(id) && !attempted.has(id)) ids.add(id);
      }
    }
    return [...ids];
  }

  private async renderDesignBundle(kind: 'component' | 'animation', content: JsonRecord) {
    const resolved = await this.resolveDesignContent(content);
    const renderable =
      kind === 'component' ? normalizeComponentStateVariants(resolved) : resolved;
    return buildBundle(kind, renderable, collectWithFixtureDependencies(renderable));
  }

  private parseManifest(content: string): PreviewManifest {
    const parsed = this.tryParseManifest(content);
    if (!parsed) throw new BadRequestException('资产版本内容不是合法 manifest');
    return parsed;
  }

  private tryParseManifest(content: string): PreviewManifest | null {
    try {
      const parsed = JSON.parse(content) as PreviewManifest;
      return parsed?.schemaVersion === 'aurum.asset.v1' ? parsed : null;
    } catch {
      return null;
    }
  }

  private toPreviewFiles(files: AssetFileDto[]): PreviewFile[] {
    return files.map((file) => ({
      path: file.path,
      content: file.content,
      target: file.target ?? undefined,
      type: file.type,
      language: file.language,
    }));
  }

  private toAiMarkdown(asset: AssetDetailDto): string {
    if (!asset.manifest) {
      return asset.format === 'token'
        ? this.toTokenAiMarkdown(asset)
        : this.toLegacyAiMarkdown(asset);
    }
    const manifest = asset.manifest;
    const ai = (manifest.ai ?? {}) as Record<string, unknown>;
    const examples = Array.isArray(ai.examples) ? ai.examples.map(String) : [];
    const antiPatterns = Array.isArray(ai.antiPatterns) ? ai.antiPatterns.map(String) : [];
    return [
      `# ${asset.name} (${asset.slug})`,
      '',
      asset.description ?? '',
      '',
      '## 什么时候用',
      asset.whenToUse ?? String(ai.usage ?? ''),
      '',
      '## 安装',
      'npx shadcn@latest add <registry-url>',
      '',
      '## Props',
      ...((manifest as unknown as Record<string, unknown>).props
        ? [JSON.stringify((manifest as unknown as Record<string, unknown>).props)]
        : ['见源码']),
      '',
      '## 示例',
      ...(examples.length ? examples : ['见源码']),
      '',
      '## Token',
      ...(manifest.tokens ?? []),
      '',
      '## 注意',
      ...(antiPatterns.length ? antiPatterns : ['按资产声明使用']),
    ].join('\n');
  }

  private toTokenAiMarkdown(asset: AssetDetailDto): string {
    return [
      `# ${asset.name} (${asset.slug})`,
      '',
      asset.description ?? 'Token / 主题资产',
      '',
      '## 何时使用',
      asset.whenToUse ?? '作为组件和布局的语义 Token 来源。',
      '',
      '## 色板',
      asset.palette.length ? asset.palette.join(', ') : '未提取到颜色',
      '',
      '## Token 文档',
      '```json',
      JSON.stringify(asset.content ?? {}, null, 2),
      '```',
    ].join('\n');
  }

  private toLegacyAiMarkdown(asset: AssetDetailDto): string {
    return [
      `# ${asset.name} (${asset.slug})`,
      '',
      asset.description ?? '旧格式设计资产',
      '',
      '这个资产是旧版 JSON 声明格式，不能作为资产包预览或直接复制 React 代码。',
      '',
      '## 原始内容',
      '```json',
      JSON.stringify(asset.content ?? {}, null, 2),
      '```',
    ].join('\n');
  }
}
