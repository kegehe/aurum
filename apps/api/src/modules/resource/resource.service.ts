import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { PassThrough, Readable } from 'node:stream';
import { ResourceRepository } from './repositories/resource.repository';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { CategoryRepository } from '../category/repositories/category.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { IJobScheduler, JOB_SCHEDULER } from '../processing/interfaces/job-scheduler.interface';
import { SearchService } from '../search/search.service';
import { AcquisitionMode, FileRole, ResourceType } from '../../common/constants/enums';
import { JobType, ProcessingStatus } from '../../common/constants/enums';
import { SearchResourceDto, ResourceSortField, SortOrder } from '../search/dto/search-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';
import {
  assertCategoryExists,
  categoryDoesNotExistError,
  isCategoryConnectError,
  isCategoryWriteError,
} from '../../common/utils/category.validation';

/**
 * 已压缩 / 难以再压缩的文件扩展名集合。
 * 批量打包 ZIP 时，这类文件使用 STORE 方式（仅复制、不压缩），
 * 避免对视频、图片、压缩包等大文件执行无效的 DEFLATE 压缩白白消耗 CPU 与等待时间。
 */
const INCOMPRESSIBLE_EXTENSIONS = new Set([
  // 视频
  'mp4',
  'mkv',
  'avi',
  'mov',
  'webm',
  'm4v',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'm2ts',
  '3gp',
  'ogv',
  'mts',
  // 音频
  'mp3',
  'flac',
  'aac',
  'ogg',
  'opus',
  'm4a',
  'wma',
  'wav',
  'aiff',
  'aif',
  // 图片（常见位图格式均已内部压缩）
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'heic',
  'heif',
  'avif',
  'jfif',
  // 压缩包 / 磁盘镜像 / 安装包
  'zip',
  'rar',
  '7z',
  'gz',
  'gzip',
  'bz2',
  'xz',
  'tgz',
  'tbz2',
  'txz',
  'zst',
  'zstd',
  'lz4',
  'lzma',
  'br',
  'cab',
  'iso',
  'dmg',
  'deb',
  'rpm',
  'apk',
  'jar',
  'war',
  'ear',
  'egg',
  'whl',
  // 已压缩文档
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'mobi',
  'azw',
  // 字体（woff2 为 Brotli 压缩，woff 通常已压缩）
  'woff',
  'woff2',
]);

/** 已压缩内容的 mimeType 精确匹配（扩展名无法识别时兜底） */
const INCOMPRESSIBLE_MIME_TYPES = new Set([
  // 图片（常见位图格式均已内部压缩；bmp/tiff/svg 等未压缩格式不在此列）
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/jfif',
  'image/vnd.microsoft.icon',
  'image/x-icon',
  // 压缩包 / 磁盘镜像 / 安装包
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/gzip',
  'application/x-gzip',
  'application/x-bzip2',
  'application/x-xz',
  'application/zstd',
  'application/x-zstd',
  'application/x-lz4',
  'application/x-lzma',
  'application/x-brotli',
  'application/pdf',
  'application/vnd.android.package-archive',
  'application/java-archive',
  'application/x-iso9660-image',
  'application/epub+zip',
  // 字体（woff/woff2 已压缩；woff2 为 Brotli，woff 为 zlib）
  'font/woff',
  'font/woff2',
  'application/x-font-woff',
  'application/x-font-woff2',
]);

/** 清空回收站的执行进度（流式接口逐条推送，便于前端展示进度条） */
export interface EmptyTrashProgress {
  /** 待处理资源总数 / 文件总数（开始清理时即确定） */
  totalResources: number;
  totalFiles: number;
  /** 已处理（成功 + 跳过）的资源数 / 文件记录数 */
  processedResources: number;
  processedFiles: number;
  /** 实际从磁盘删除的文件数：共用文件只计一次，仍被正常资源引用的不计 */
  deletedResources: number;
  deletedFiles: number;
  /** 已被并发请求删除而跳过的资源数 */
  skippedResources: number;
}

@Injectable()
export class ResourceService {
  private readonly logger = new Logger(ResourceService.name);

  constructor(
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly categoryRepo: CategoryRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly searchService: SearchService,
  ) {}

  /**
   * 详情页大图预览缓存。
   *
   * 43MB / 3232×5760 的 PNG 直接内联会先传 43MB、再让浏览器解码 1800 万像素，
   * 打开详情要 1s 以上。这里按需缩到 2560px 的 WebP（~几百 KB），
   * 结果缓存在进程内，后续请求只读内存。
   */
  private readonly previewCache = new Map<string, { buffer: Buffer; mimeType: string }>();
  private previewCacheBytes = 0;
  private static readonly PREVIEW_CACHE_LIMIT_BYTES = 48 * 1024 * 1024;
  /**
   * 单次缩放允许读入的原图上限。
   *
   * 缩放需要 `storage.get()` 把整份原图读进 Buffer 再交给 Sharp 解码，
   * 超过这个体积时直接回退原图流，避免一次预览请求把进程内存拉高上百 MB。
   */
  private static readonly PREVIEW_MAX_INPUT_BYTES = 64 * 1024 * 1024;
  /** 可以安全栅格化成静态预览的图片类型（动图缩放会丢帧，SVG 不在白名单） */
  private static readonly RESIZABLE_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/tiff',
  ]);

  /** 可以直接内嵌成 data URI 的图片类型（SVG/TIFF 不进设计预览） */
  private static readonly INLINE_MEDIA_MIME = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
  ]);

  /**
   * 缩放并发闸门：每次缩放都要把整张原图读进内存再交给 Sharp 解码，
   * 并发请求多时峰值内存成倍增长。超出上限的请求在读取文件前排队。
   */
  private static readonly PREVIEW_RESIZE_CONCURRENCY = 2;
  private previewResizeActive = 0;
  private previewResizeWaiters: Array<() => void> = [];

  /**
   * 回收站统计的短 TTL 缓存。
   *
   * 统计与列表并行拉取，但翻页、恢复、删除后的刷新都会重复计算一次全量文件；
   * 回收站很大时每次交互都要扫全表。TTL 内复用结果，所有会改变回收站内容的
   * 操作显式失效，保证用户自己的操作立刻可见。
   */
  private trashStatsCache: {
    value: { resourceCount: number; fileCount: number; totalSizeBytes: string };
    expiresAt: number;
  } | null = null;
  /** 失效代数：读穿计算期间发生过失效时，丢弃这次结果而不是写回缓存 */
  private trashStatsEpoch = 0;
  private static readonly TRASH_STATS_TTL_MS = 5_000;

  /**
   * 分页查询资源列表（默认排除已软删除）
   * 搜索/筛选逻辑委托 SearchService.buildWhereClause()
   */
  async findMany(query: SearchResourceDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where = this.searchService.buildWhereClause(query);
    const orderBy = this.searchService.buildOrderBy(query.sortBy, query.sortOrder);

    const [items, total] = await Promise.all([
      this.resourceRepo.findMany({ where, orderBy, page, pageSize }),
      this.resourceRepo.count(where),
    ]);

    // BigInt 无法 JSON 序列化，转成字符串
    const serializedItems = items.map(({ locators, ...item }) => {
      const downloadLocator = locators.find((locator) => locator.locatorType === 'download');
      return {
        ...item,
        sizeBytes: item.sizeBytes.toString(),
        // 远端缩略图只认 preview 定位器；没有时前端会退回 downloadUrl。
        previewUrl: locators.find((locator) => locator.locatorType === 'preview')?.url ?? null,
        // 远端媒体的真实地址（下载定位器）。视频卡片要用它播放，不能拿预览缩略图当视频源。
        downloadUrl: downloadLocator?.url ?? null,
        // 远程资源下载失败时列表要能直接看出原因，而不是只显示“远程资源”
        downloadError:
          item.acquisitionMode === 'metadata_only' ? (downloadLocator?.lastError ?? null) : null,
        downloadAttempts: downloadLocator?.downloadAttempts ?? 0,
      };
    });

    return {
      items: serializedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 当前筛选范围内的全部资源 ID（"全选当前目录"用）。
   *
   * 列表接口 pageSize 上限为 100，几千条资源要靠前端逐页翻几十次；
   * 这里用同一套 where 条件一次取回全部 ID（只查 id 列，不带关联），
   * 一次往返即可完成全选。返回值不带分页信息，调用方应以本次快照为准。
   */
  async findIds(query: SearchResourceDto): Promise<{ ids: string[]; total: number }> {
    const where = this.searchService.buildWhereClause(query);
    const rows = await this.resourceRepo.findIds(where);
    return { ids: rows.map((row) => row.id), total: rows.length };
  }

  /**
   * 轻量查询：仅获取资源基础字段（不含关联数据）
   * 用于缩略图端点等只需少量字段的场景，避免加载 files/locators 等关联
   */
  async findBasicById(id: string) {
    return this.resourceRepo.findById(id);
  }

  /**
   * 相邻资源导航：返回资源列表（应用相同筛选与排序上下文）中当前资源的上一个/下一个资源 ID。
   * - 列表以用户选择的排序字段排序，并列排序值以 id 升序作确定性全序（比列表单字段排序更稳定）；
   * - 资源不在当前筛选结果中（被筛选掉）时返回两个 null，前端据此隐藏箭头；
   * - currentIndex 为 1 起始的位置，total 为筛选范围内资源总数，可用于展示 "3 / 50"。
   */
  async findNeighbors(id: string, query: SearchResourceDto) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }

    const where = this.searchService.buildWhereClause(query);
    const sortField = query.sortBy ?? ResourceSortField.createdAt;
    const sortOrder = query.sortOrder ?? SortOrder.desc;
    const order: 'asc' | 'desc' = sortOrder === SortOrder.asc ? 'asc' : 'desc';

    // 总数与"当前资源是否在筛选范围内"可以并行；后者为 0 时直接返回空箭头。
    const [total, inScope] = await Promise.all([
      this.resourceRepo.count(where),
      this.resourceRepo.count({ AND: [where, { id }] }),
    ]);
    if (inScope === 0) {
      return { previousId: null, nextId: null, currentIndex: null, total };
    }

    // 排序字段在 schema 里都非空，直接取当前行的值做游标，不需要额外查询。
    const key = existing[sortField];
    const cursor = { where, field: sortField, key, id, order };

    // 之前：取回筛选范围内全部行 + JS 排序（7411 条约 100–160ms，随数据量线性增长）。
    // 现在：3 个带索引条件的查询 + LIMIT 1，耗时与结果集大小无关。
    const [beforeCount, previous, next] = await Promise.all([
      this.resourceRepo.countBefore(cursor),
      this.resourceRepo.findNeighbor({ ...cursor, direction: 'previous' }),
      this.resourceRepo.findNeighbor({ ...cursor, direction: 'next' }),
    ]);

    return {
      previousId: previous?.id ?? null,
      nextId: next?.id ?? null,
      currentIndex: beforeCount + 1,
      total,
    };
  }

  /**
   * 资源详情：含文件列表、重复提示
   */
  async findById(id: string) {
    const resource = await this.resourceRepo.findByIdWithRelations(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }

    return {
      ...resource,
      sizeBytes: resource.sizeBytes.toString(),
      files: resource.files.map((f) => ({ ...f, sizeBytes: f.sizeBytes.toString() })),
      locators: resource.locators.map((locator) => ({
        ...locator,
        contentLength: locator.contentLength?.toString() ?? null,
      })),
      isDuplicate: !!resource.duplicateOfId,
      duplicateOf: resource.duplicateOf,
    };
  }

  /** 更新资源元数据 */
  async update(id: string, dto: UpdateResourceDto) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const data: Prisma.ResourceUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.source !== undefined) data.source = dto.source;
    if (dto.author !== undefined) data.author = dto.author;
    if (dto.categoryId !== undefined) {
      if (dto.categoryId === null) {
        // null → 断开分类关联
        data.category = { disconnect: true };
      } else {
        // string → 连接新分类；分类可能已被并发删除，先校验避免数据库外键错误变成 500
        await assertCategoryExists((id) => this.categoryRepo.findById(id), dto.categoryId);
        data.category = { connect: { id: dto.categoryId } };
      }
    }
    try {
      const updated = await this.resourceRepo.update(id, data);
      return { ...updated, sizeBytes: updated.sizeBytes.toString() };
    } catch (error) {
      // 兜底：分类在"校验"与"写入"之间被并发删除时，把外键错误转成可读的 400。
      // 注意：P2025 的消息在 data 含分类 connect 时，即使实际缺失的是资源（被并发删除），
      // 也会优先报告嵌套 connect 的 'Category'。因此这里复查分类来区分：
      // 分类已不存在 → 分类问题（400）；分类仍在 → 资源被并发删除（404）。
      if (typeof dto.categoryId === 'string' && isCategoryConnectError(error)) {
        const category = await this.categoryRepo.findById(dto.categoryId);
        if (!category) {
          throw categoryDoesNotExistError(dto.categoryId);
        }
        throw new NotFoundException(`Resource ${id} not found`);
      }
      throw error;
    }
  }

  async batchSetCategory(ids: string[], categoryId: string | null) {
    if (categoryId !== null) {
      await assertCategoryExists((id) => this.categoryRepo.findById(id), categoryId);
    }
    try {
      const updated = await this.resourceRepo.batchSetCategory(ids, categoryId);
      return {
        resourceIds: ids,
        categoryId,
        updated,
        failed: ids.length - updated,
      };
    } catch (error) {
      // 兜底：分类在"校验"与"写入"之间被并发删除时，把外键错误转成可读的 400。
      // updateMany 直接写 categoryId 时外键失败为 P2003（SQLite 消息通用，不含字段名），
      // 且该操作唯一写到的外键就是 categoryId，因此按错误码判定即可。
      if (isCategoryWriteError(error)) {
        throw categoryDoesNotExistError(categoryId);
      }
      throw error;
    }
  }

  async batchSetFavorite(ids: string[], isFavorite: boolean) {
    const updated = await this.resourceRepo.batchSetFavorite(ids, isFavorite);
    return {
      resourceIds: ids,
      isFavorite,
      updated,
      failed: ids.length - updated,
    };
  }

  async batchSoftDelete(ids: string[]) {
    const deleted = await this.resourceRepo.batchSoftDelete(ids);
    this.invalidateTrashStats();
    return {
      resourceIds: ids,
      deleted,
      failed: ids.length - deleted,
    };
  }

  async createBatchDownload(ids: string[]): Promise<{
    stream: Readable;
    filename: string;
    foundResources: number;
    missingResources: number;
    missingResourceIds: string[];
  }> {
    const requestedIds = [...new Set(ids)];
    const resources = await this.resourceRepo.findActiveOriginalFiles(requestedIds);
    const downloadableResources = resources.filter((resource) => resource.files.length > 0);
    if (downloadableResources.length === 0) {
      throw new NotFoundException(
        '所选资源都没有本地原文件，无法打包下载。链接资源或仅元数据资源需要先下载到本地。',
      );
    }

    // 没有本地原文件的资源（链接 / 仅元数据 / 已失联）不会进入压缩包，
    // 需要把每一笔跳过都记录下来，前端才能如实提示数量并告诉用户少了哪些。
    const downloadableIds = new Set(downloadableResources.map((resource) => resource.id));
    const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));
    const skippedResources = requestedIds
      .filter((id) => !downloadableIds.has(id))
      .map((id) => {
        const resource = resourcesById.get(id);
        const rawTitle = resource ? resource.title || resource.originalFilename || id : id;
        return {
          id,
          // 标题来自外部来源，压平换行避免清单格式被破坏
          title: rawTitle.replace(/\s+/g, ' ').trim() || id,
          reason: resource ? '无本地原文件' : '资源不存在或已删除',
        };
      });

    // 使用 zlib 默认 DEFLATE 压缩级别（level 6），仅对文本等可压缩内容生效；
    // 视频、图片、压缩包等已压缩格式通过每项 store: true 跳过压缩，避免大文件白白消耗 CPU。
    // 注意：不传 zlib 时 compress-commons 会默认到 Z_BEST_SPEED(1)，因此这里显式指定标准默认值。
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = new PassThrough();
    const usedNames = new Map<string, number>();
    // 先占位清单文件名，保证 toast 里提示的 _skipped-resources.txt 不会因资源重名被改名
    const skippedManifestName =
      skippedResources.length > 0
        ? this.uniqueArchiveName('_skipped-resources.txt', usedNames)
        : null;
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);

    setImmediate(() => {
      void (async () => {
        try {
          for (const resource of downloadableResources) {
            // 客户端取消/断开时 controller 会 destroy 输出流，这里立刻收手：
            // 否则还会把剩下的资源逐个读出来打包，白白消耗磁盘 IO
            if (output.destroyed) {
              archive.destroy();
              return;
            }
            const [originalFile] = resource.files;
            const stream = await this.storage.getStream(originalFile.storagePath);
            const name = this.uniqueArchiveName(
              this.safeArchiveName(resource.originalFilename || resource.title || resource.id),
              usedNames,
            );
            archive.append(stream, {
              name,
              store: this.isAlreadyCompressed(name, originalFile.mimeType, originalFile.extension),
            });
          }
          if (skippedManifestName) {
            archive.append(
              this.buildSkippedResourcesManifest(
                skippedResources,
                requestedIds.length,
                downloadableResources.length,
              ),
              { name: skippedManifestName },
            );
          }
          await archive.finalize();
        } catch (e) {
          archive.destroy(e instanceof Error ? e : new Error(String(e)));
          output.destroy(e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });

    return {
      stream: output,
      filename: `resources-${new Date().toISOString().slice(0, 10)}.zip`,
      foundResources: downloadableResources.length,
      missingResources: skippedResources.length,
      missingResourceIds: skippedResources.map((resource) => resource.id),
    };
  }

  /**
   * 获取原文件可读流（用于下载）
   * 安全：通过 resource_id 查 DB 取 storage_path，不接受客户端传入路径
   */
  async getOriginalFile(id: string): Promise<{
    stream: Readable;
    mimeType: string;
    originalFilename: string;
  }> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const originalFile = await this.fileRepo.findByResourceAndRole(id, FileRole.original);
    if (!originalFile) {
      throw new NotFoundException(`Original file for resource ${id} not found`);
    }
    const stream = await this.storage.getStream(originalFile.storagePath);
    return {
      stream,
      mimeType: resource.mimeType,
      originalFilename: resource.originalFilename,
    };
  }

  /**
   * 获取原文件元信息（用于内联预览）
   * 不打开文件流，避免无效 Range 请求浪费资源
   */
  async getOriginalFileInfo(id: string): Promise<{
    mimeType: string;
    originalFilename: string;
    sizeBytes: number;
  }> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const originalFile = await this.fileRepo.findByResourceAndRole(id, FileRole.original);
    if (!originalFile) {
      throw new NotFoundException(`Original file for resource ${id} not found`);
    }
    return {
      mimeType: resource.mimeType,
      originalFilename: resource.originalFilename,
      sizeBytes: Number(originalFile.sizeBytes),
    };
  }

  /**
   * 获取原文件指定字节范围的可读流（支持视频/音频 seek）
   * 调用方需先通过 getOriginalFileInfo 校验资源与原文件存在
   */
  async getOriginalFileRange(id: string, start: number, end: number): Promise<Readable> {
    const originalFile = await this.fileRepo.findByResourceAndRole(id, FileRole.original);
    if (!originalFile) {
      throw new NotFoundException(`Original file for resource ${id} not found`);
    }
    return this.storage.getStreamRange(originalFile.storagePath, start, end);
  }

  /**
   * 生成缩放后的图片预览（仅静态位图）。
   *
   * 返回 null 表示不需要或不能缩放（非图片、动图、原图本来就小、原文件记录缺失、
   * 解码失败），调用方应回退到原文件/缩略图分支。
   */
  async getResizedPreview(
    id: string,
    maxEdge: number,
  ): Promise<{ buffer: Buffer; mimeType: string; originalFilename: string } | null> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const baseType = resource.mimeType.split(';', 1)[0].trim().toLowerCase();
    if (!ResourceService.RESIZABLE_IMAGE_TYPES.has(baseType)) {
      return null;
    }
    // DB 里已记录尺寸时直接判断，避免为了一个小图把文件读出来再解码
    const recordedSide = Math.max(resource.width ?? 0, resource.height ?? 0);
    if (recordedSide > 0 && recordedSide <= maxEdge) {
      return null;
    }

    const cacheKey = `${id}:${maxEdge}`;
    const cached = this.previewCache.get(cacheKey);
    if (cached) {
      return { ...cached, originalFilename: resource.originalFilename };
    }

    const originalFile = await this.fileRepo.findByResourceAndRole(id, FileRole.original);
    if (!originalFile) {
      // 只有缩略图的资源：这里抛 404 会让整个资源预览裂掉，交回调用方降级。
      return null;
    }
    // 超大原图不读进内存：直接返回 null，由调用方回退到原文件流
    if (originalFile.sizeBytes > BigInt(ResourceService.PREVIEW_MAX_INPUT_BYTES)) {
      return null;
    }

    let buffer: Buffer;
    // 从读文件到编码完成都占用一个槽位：原图 Buffer 和 Sharp 的像素缓冲
    // 才是内存大头，排队必须排在这之前。
    const release = await this.acquirePreviewResizeSlot();
    try {
      let input: Buffer;
      try {
        input = await this.storage.get(originalFile.storagePath);
      } catch {
        // 记录还在但原文件丢了：交给调用方回退缩略图/原图分支，
        // 不要让 /preview 直接 404 掉整个资源。
        return null;
      }
      try {
        // 只读头部拿尺寸/帧数：小图不必重新编码，动图缩放会丢帧（交给原图分支）
        const metadata = await sharp(input).metadata();
        if ((metadata.pages ?? 1) > 1) return null;
        if ((metadata.width ?? 0) <= maxEdge && (metadata.height ?? 0) <= maxEdge) return null;

        buffer = await sharp(input)
          .rotate()
          .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
      } catch {
        // 损坏或 libvips 不支持的格式：交给原图分支
        return null;
      }
    } finally {
      release();
    }

    const mimeType = 'image/webp';
    this.cachePreview(cacheKey, { buffer, mimeType });
    return { buffer, mimeType, originalFilename: resource.originalFilename };
  }

  /**
   * 取得一个缩放槽位，返回释放函数。
   *
   * 释放时若有等待者，直接把槽位移交（不自减再让别人自增），避免「刚释放
   * 一个、新请求立刻抢占、被唤醒的等待者也同时进入」导致并发超限。
   */
  private async acquirePreviewResizeSlot(): Promise<() => void> {
    if (this.previewResizeActive < ResourceService.PREVIEW_RESIZE_CONCURRENCY) {
      this.previewResizeActive += 1;
    } else {
      await new Promise<void>((resolve) => this.previewResizeWaiters.push(resolve));
      // 槽位由释放方直接移交，这里不再自增
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.previewResizeWaiters.shift();
      if (next) next();
      else this.previewResizeActive -= 1;
    };
  }

  /** 按总字节数淘汰的 FIFO 缓存；单张过大则不入缓存，避免挤掉所有条目 */
  private cachePreview(key: string, value: { buffer: Buffer; mimeType: string }): void {
    const size = value.buffer.byteLength;
    if (size > ResourceService.PREVIEW_CACHE_LIMIT_BYTES) return;

    const existing = this.previewCache.get(key);
    if (existing) this.previewCacheBytes -= existing.buffer.byteLength;
    this.previewCache.set(key, value);
    this.previewCacheBytes += size;

    while (this.previewCacheBytes > ResourceService.PREVIEW_CACHE_LIMIT_BYTES) {
      const oldestKey = this.previewCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const removed = this.previewCache.get(oldestKey);
      this.previewCache.delete(oldestKey);
      this.previewCacheBytes -= removed?.buffer.byteLength ?? 0;
    }
  }

  /**
   * 获取派生文件（快照 / 缩略图 / 提取文本 / 转码）的可读流
   *
   * 原文件走 /download，派生文件按角色取，避免为每个角色开一个端点。
   * 存储路径只来自数据库记录，角色名不参与路径拼接。
   */
  async getDerivedFile(
    id: string,
    role: Exclude<FileRole, FileRole.original>,
  ): Promise<{
    stream: Readable;
    mimeType: string;
    originalFilename: string;
  }> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const file = await this.fileRepo.findByResourceAndRole(id, role);
    if (!file) {
      throw new NotFoundException(`${role} file for resource ${id} not found`);
    }
    const base = resource.originalFilename.replace(/\.[a-zA-Z0-9]{1,10}$/, '');
    const stream = await this.storage.getStream(file.storagePath);
    return {
      stream,
      mimeType: file.mimeType,
      originalFilename: `${base}.${role}${file.extension ? `.${file.extension}` : ''}`,
    };
  }

  /**
   * 获取缩略图可读流。
   *
   * - 成功路径只查一次 resource_files（缩略图命中是常态，不再先查 resource）
   * - 返回 ETag，命中 If-None-Match 时调用方直接回 304，省掉一次文件读取
   * - 缩略图尚未生成时返回 null（resource 是否存在由这里判定）
   */
  async getThumbnailFile(
    id: string,
    ifNoneMatch?: string,
  ): Promise<
    | { notModified: true; etag: string }
    | { notModified?: false; stream: Readable; mimeType: string; etag: string }
    | null
  > {
    const thumbnailFile = await this.fileRepo.findByResourceAndRole(id, FileRole.thumbnail);
    if (!thumbnailFile) {
      const resource = await this.resourceRepo.findById(id);
      if (!resource) {
        throw new NotFoundException(`Resource ${id} not found`);
      }
      return null;
    }

    const etag = `"${thumbnailFile.id}-${thumbnailFile.sizeBytes.toString()}"`;
    if (ifNoneMatch && ifNoneMatch === etag) {
      return { notModified: true, etag };
    }

    const stream = await this.storage.getStream(thumbnailFile.storagePath);
    return {
      stream,
      mimeType: thumbnailFile.mimeType || 'image/webp',
      etag,
    };
  }

  /**
   * 设计素材可用性检查。
   *
   * 只接受有本地文件的图片/视频；视频必须有已生成的封面帧。
   * 这里不读文件字节，供「一句话生成」在建任务前快速校验。
   */
  async assertDesignMedia(id: string): Promise<{
    kind: 'image' | 'video';
    title: string;
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  }> {
    const { resource, kind } = await this.loadDesignMedia(id);
    const duration = resource.durationSeconds === null ? null : Number(resource.durationSeconds);
    return {
      kind,
      title: resource.title || resource.originalFilename,
      width: resource.width,
      height: resource.height,
      durationSeconds:
        duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }

  /**
   * 读取设计素材字节。
   *
   * 图片优先用按需缩放的 WebP（大图），其次原图（不超过上限），最后缩略图；
   * 视频只使用封面帧。返回的 cacheKey 供上层缓存 data URI，避免滑块预览反复读盘。
   */
  async readDesignMedia(
    id: string,
    options: { maxEdge?: number; maxBytes?: number } = {},
  ): Promise<{
    buffer: Buffer;
    mimeType: string;
    kind: 'image' | 'video';
    cacheKey: string;
  }> {
    const { resource, kind } = await this.loadDesignMedia(id);
    const maxEdge = Math.min(2048, Math.max(512, Math.round(options.maxEdge ?? 1200)));
    const maxBytes = Math.min(
      16 * 1024 * 1024,
      Math.max(256 * 1024, Math.round(options.maxBytes ?? 4 * 1024 * 1024)),
    );

    if (kind === 'video') {
      const thumbnail = await this.getThumbnailFile(id);
      if (!thumbnail || thumbnail.notModified) {
        throw new BadRequestException('视频封面还没生成，请等处理完成后再试');
      }
      return {
        buffer: await this.readStreamBuffer(thumbnail.stream, maxBytes),
        mimeType: normalizeMimeType(thumbnail.mimeType),
        kind,
        cacheKey: thumbnail.etag,
      };
    }

    // 只有缩略图、没有原文件的图片：getResizedPreview 需要读原文件，可能直接抛
    // NotFound。这里必须降级到后面的缩略图分支，而不是让整个素材读取失败。
    const resized = await this.getResizedPreview(id, maxEdge).catch(() => null);
    if (resized && resized.buffer.length <= maxBytes) {
      return {
        buffer: resized.buffer,
        mimeType: normalizeMimeType(resized.mimeType),
        kind,
        cacheKey: `${resource.sha256 ?? resource.id}:${maxEdge}`,
      };
    }

    // 小图/动图：原图质量最好，但不能无限大；超过上限再回退缩略图。
    const originalInfo = await this.getOriginalFileInfo(id).catch(() => null);
    const originalMime = originalInfo ? normalizeMimeType(originalInfo.mimeType) : '';
    if (
      originalInfo &&
      originalInfo.sizeBytes <= maxBytes &&
      ResourceService.INLINE_MEDIA_MIME.has(originalMime)
    ) {
      const original = await this.getOriginalFile(id);
      return {
        buffer: await this.readStreamBuffer(original.stream, maxBytes),
        mimeType: originalMime,
        kind,
        cacheKey: `${resource.sha256 ?? resource.id}:${originalInfo.sizeBytes}`,
      };
    }

    const thumbnail = await this.getThumbnailFile(id);
    if (thumbnail && !thumbnail.notModified) {
      const mimeType = normalizeMimeType(thumbnail.mimeType);
      if (ResourceService.INLINE_MEDIA_MIME.has(mimeType)) {
        return {
          buffer: await this.readStreamBuffer(thumbnail.stream, maxBytes),
          mimeType,
          kind,
          cacheKey: thumbnail.etag,
        };
      }
      thumbnail.stream.destroy();
    }

    throw new BadRequestException('该图片格式无法直接内嵌，请重新处理生成缩略图后再试');
  }

  private async loadDesignMedia(id: string): Promise<{
    resource: NonNullable<Awaited<ReturnType<ResourceRepository['findById']>>>;
    kind: 'image' | 'video';
  }> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource || resource.deletedAt) {
      throw new NotFoundException(`Resource ${id} not found or deleted`);
    }
    if (
      resource.resourceType !== ResourceType.image &&
      resource.resourceType !== ResourceType.video
    ) {
      throw new BadRequestException('只有图片或视频可以作为设计素材');
    }

    const [originalFile, thumbnailFile] = await Promise.all([
      this.fileRepo.findByResourceAndRole(id, FileRole.original),
      this.fileRepo.findByResourceAndRole(id, FileRole.thumbnail),
    ]);
    const remoteOnly =
      resource.acquisitionMode === AcquisitionMode.link_only ||
      resource.acquisitionMode === AcquisitionMode.metadata_only;
    if (remoteOnly && !originalFile && !thumbnailFile) {
      throw new BadRequestException('该资源还没有本地文件，请先在资源详情下载到本地');
    }
    if (resource.resourceType === ResourceType.video && !thumbnailFile) {
      throw new BadRequestException('视频封面还没生成，请等处理完成后再试');
    }
    if (resource.resourceType === ResourceType.image && !originalFile && !thumbnailFile) {
      throw new BadRequestException('该资源还没有本地文件，请先在资源详情下载到本地');
    }
    return {
      resource,
      kind: resource.resourceType === ResourceType.video ? 'video' : 'image',
    };
  }

  private async readStreamBuffer(stream: Readable, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (size > maxBytes) {
          throw new BadRequestException(
            `素材文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`,
          );
        }
        chunks.push(buffer);
      }
    } catch (error) {
      stream.destroy();
      throw error;
    }
    return Buffer.concat(chunks, size);
  }

  /** 软删除 */
  async softDelete(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.softDelete(id);
    this.invalidateTrashStats();
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 恢复 */
  async restore(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.restore(id);
    this.invalidateTrashStats();
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 批量恢复：一次请求恢复多个回收站资源，并汇总未恢复成功的资源 */
  async batchRestore(ids: string[]) {
    const { restored, failedIds } = await this.resourceRepo.batchRestore(ids);
    this.invalidateTrashStats();
    return {
      resourceIds: ids,
      restored,
      failed: failedIds.length,
      failedResourceIds: failedIds,
    };
  }

  /**
   * 彻底删除：清理数据库记录与磁盘文件。只允许删除已在回收站中的资源。
   *
   * 先删记录、再删文件：
   * - `deleteDeleted` 只在记录仍处于回收站时生效，返回 0 说明记录刚被并发恢复
   *   或被另一个请求删除。此时绝不能再动磁盘文件，否则恢复后的资源会指向
   *   不存在的文件；
   * - 记录删除后做引用检查，内容寻址导致的重复资源共用文件只要还有引用就保留。
   * 代价是磁盘删除失败会留下孤儿文件（一致性检查可发现），但这比产生
   * 「记录还在、文件没了」的坏资源安全。
   */
  async permanentDelete(id: string) {
    const resource = await this.resourceRepo.findByIdWithRelations(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    if (!resource.deletedAt) {
      throw new BadRequestException(`Resource ${id} is not in trash`);
    }

    const deletedCount = await this.resourceRepo.deleteDeleted(id);
    this.invalidateTrashStats();
    if (deletedCount === 0) {
      // 并发恢复或已被另一个请求彻底删除：磁盘文件不归本次请求处理
      return { id, deleted: false, deletedFiles: 0 };
    }

    // 本资源的 file 行已随记录级联删除，剩下的引用都来自其它资源
    const deletedFiles = await this.deleteUnreferencedFiles(
      resource.files.map((file) => file.storagePath),
    );

    return { id, deleted: true, deletedFiles };
  }

  /**
   * 回收站统计：已删除资源数、可回收文件数与可回收字节数。
   *
   * 存储 key 按内容哈希生成，同一份磁盘文件可能被多条重复资源引用，因此按
   * storagePath 去重；仍被回收站之外资源引用的文件在清空时不会删除，也不
   * 计入可回收大小。BigInt 无法 JSON 序列化，统一转成字符串。
   */
  async getTrashStats() {
    const cached = this.trashStatsCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const epoch = this.trashStatsEpoch;
    const value = await this.computeTrashStats();
    // 计算期间回收站发生了变化：这次结果已经过期，不能覆盖失效动作
    if (epoch === this.trashStatsEpoch) {
      this.trashStatsCache = {
        value,
        expiresAt: Date.now() + ResourceService.TRASH_STATS_TTL_MS,
      };
    }
    return value;
  }

  /**
   * 回收站内容变化后立即失效统计缓存。
   *
   * 公开给同样会改动 deletedAt 的模块（例如链接导入时复活回收站资源），
   * 避免它们只能等 TTL 过期。
   */
  invalidateTrashStats() {
    this.trashStatsEpoch += 1;
    this.trashStatsCache = null;
  }

  private async computeTrashStats() {
    const { resourceCount, files } = await this.resourceRepo.getTrashFileUsage();

    // 同一路径理论上大小一致；取最大值只是防御脏数据
    const sizeByPath = new Map<string, bigint>();
    for (const file of files) {
      const current = sizeByPath.get(file.storagePath);
      if (current === undefined || file.sizeBytes > current) {
        sizeByPath.set(file.storagePath, file.sizeBytes);
      }
    }

    const trashResourceIds = new Set(files.map((file) => file.resourceId));
    if (sizeByPath.size === 0) {
      return { resourceCount, fileCount: 0, totalSizeBytes: '0' };
    }

    const referenced = await this.fileRepo.findStoragePathReferences([...sizeByPath.keys()]);
    const reclaimablePaths = [...sizeByPath.keys()].filter((storagePath) => {
      const resourceIds = referenced.get(storagePath);
      if (!resourceIds) return true;
      for (const resourceId of resourceIds) {
        if (!trashResourceIds.has(resourceId)) return false;
      }
      return true;
    });

    const totalSizeBytes = reclaimablePaths.reduce(
      (sum, storagePath) => sum + (sizeByPath.get(storagePath) ?? 0n),
      0n,
    );

    return {
      resourceCount,
      fileCount: reclaimablePaths.length,
      totalSizeBytes: totalSizeBytes.toString(),
    };
  }

  /**
   * 清空回收站
   *
   * onProgress：逐条删除时推送进度，供 SSE 接口驱动前端进度条。
   * 注意：清理过程不可中途取消（客户端断开也会继续删除到底）。
   *
   * 分两阶段：先逐条删除数据库记录，再统一清理磁盘文件。
   * - 只有 `deleteDeleted` 确认删掉的记录才收集文件；并发恢复的资源返回 0，
   *   其文件不会被误删；
   * - 文件清理以「记录删除后」的引用状态为准，重复资源共用的文件只删一次，
   *   仍被正常资源引用的文件保留。
   */
  async emptyTrash(options?: { onProgress?: (progress: EmptyTrashProgress) => void }) {
    // 清空过程可能持续很久，先让统计缓存失效，避免期间一直返回清空前的数字
    this.invalidateTrashStats();
    const resources = await this.resourceRepo.findDeletedWithFiles();
    const totalResources = resources.length;
    const totalFiles = resources.reduce((sum, resource) => sum + resource.files.length, 0);

    let processedResources = 0;
    let processedFiles = 0;
    let deletedResources = 0;
    let deletedFiles = 0;
    let skippedResources = 0;

    const emitProgress = () =>
      options?.onProgress?.({
        totalResources,
        totalFiles,
        processedResources,
        processedFiles,
        deletedResources,
        deletedFiles,
        skippedResources,
      });

    // 先推一次 0 进度：前端据此立刻拿到总数并渲染进度条，而不是空白等待
    emitProgress();

    // 第一阶段：删除数据库记录，只收集真正删掉的资源的文件。
    // 中途抛错也要进入第二阶段：已经删掉的记录如果不清文件，就会留下永久孤儿。
    const storagePaths: string[] = [];
    let phaseError: unknown = null;
    try {
      for (const resource of resources) {
        // 幂等：并发删除时 count=0；并发恢复时同样 count=0（deletedAt 已为空）
        const count = await this.resourceRepo.deleteDeleted(resource.id);
        if (count > 0) {
          deletedResources++;
          storagePaths.push(...resource.files.map((file) => file.storagePath));
        } else {
          // 已被并发请求删除，或刚被恢复：不碰它的磁盘文件
          skippedResources++;
        }
        processedResources++;
        processedFiles += resource.files.length;
        emitProgress();
      }
    } catch (error) {
      phaseError = error;
    } finally {
      // 第二阶段：记录已删，按删除后的引用状态回收磁盘文件
      deletedFiles = await this.deleteUnreferencedFiles(storagePaths, (count) => {
        deletedFiles = count;
        emitProgress();
      });
      // 期间可能有请求把「清到一半」的结果写进缓存，结束时再失效一次
      this.invalidateTrashStats();
    }
    if (phaseError) throw phaseError;

    return {
      deletedResources,
      deletedFiles,
      skippedResources,
    };
  }

  /**
   * 删除没有任何 ResourceFile 引用的磁盘文件，返回实际删除成功数。
   *
   * 必须在删除数据库记录之后调用，这样引用检查反映的是「删除后」的真实状态：
   * - 并发恢复的资源仍在库中 → 其文件被跳过；
   * - 内容寻址导致的重复资源共用文件 → 只要还有一条引用就保留；
   * - 同一路径在一次清理中只处理一次。
   *
   * 引用检查或 unlink 失败不抛错：记录已经删掉，失败只会留下孤儿文件
   * （一致性检查可以找出），不会产生指向缺失文件的坏记录。
   *
   * 残余窗口：引用查询返回后到 unlink 之间，另一个进程仍可能提交新的
   * ResourceFile 行或 put() 同一 key。彻底消除需要内容寻址 blob 的引用计数
   * 或延迟 GC；这里把窗口压缩到极短，查询前已提交的引用一定不会被误删。
   */
  private async deleteUnreferencedFiles(
    storagePaths: string[],
    onProgress?: (deletedCount: number) => void,
  ): Promise<number> {
    const uniquePaths = [...new Set(storagePaths)];
    if (uniquePaths.length === 0) return 0;

    let references: Map<string, Set<string>>;
    try {
      references = await this.fileRepo.findStoragePathReferences(uniquePaths);
    } catch (error) {
      this.logger.warn(`Skip storage cleanup: reference check failed: ${describeError(error)}`);
      return 0;
    }

    const unreferencedPaths = uniquePaths.filter((path) => !references.has(path));
    let deletedCount = 0;
    const failures: Array<{ path: string; error: unknown }> = [];
    const chunkSize = 100;
    for (let offset = 0; offset < unreferencedPaths.length; offset += chunkSize) {
      const chunk = unreferencedPaths.slice(offset, offset + chunkSize);
      const results = await Promise.all(
        chunk.map(async (path) => {
          try {
            await this.storage.delete(path);
            return 1;
          } catch (error) {
            failures.push({ path, error });
            return 0;
          }
        }),
      );
      deletedCount += results.reduce<number>((sum, count) => sum + count, 0);
      onProgress?.(deletedCount);
    }

    // 磁盘批量失败时只汇总一条日志，避免刷屏
    if (failures.length > 0) {
      this.logger.warn(
        `Failed to delete ${failures.length}/${unreferencedPaths.length} unreferenced files; ` +
          `first error (${failures[0].path}): ${describeError(failures[0].error)}`,
      );
    }

    return deletedCount;
  }

  /** 重新处理：创建新的元数据检测任务，并标记资源正在处理 */
  async reprocess(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    // 创建新的检测任务（调度器会自动去重）
    await this.scheduler.enqueue(JobType.detect_metadata, id);
    await this.resourceRepo.updateProcessingStatus(id, ProcessingStatus.processing);
    return { id, processingStatus: ProcessingStatus.processing };
  }

  /**
   * 生成压缩包内的跳过清单：明确列出没有本地原文件、因而未被打包的资源。
   * 以 UTF-8 BOM 编码，保证 Windows 记事本打开中文不乱码。
   */
  private buildSkippedResourcesManifest(
    skipped: { id: string; title: string; reason: string }[],
    requestedCount: number,
    foundCount: number,
  ): Buffer {
    const lines = [
      `共选择 ${requestedCount} 个资源，已打包 ${foundCount} 个，跳过 ${skipped.length} 个。`,
      '',
      '以下资源未包含在此压缩包中：',
      ...skipped.map((item) => `- ${item.title}（${item.reason}，ID: ${item.id}）`),
      '',
      '说明：链接资源、仅元数据资源没有本地原文件，需要先下载到本地后才能打包。',
      '',
    ];
    return Buffer.from(`\uFEFF${lines.join('\n')}`, 'utf8');
  }

  private safeArchiveName(name: string): string {
    const cleaned = name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'resource';
  }

  /**
   * 判断归档条目是否为已压缩 / 难以再压缩的类型。
   * 命中时打包使用 STORE（仅复制），否则交给默认 DEFLATE 压缩。
   * 优先看文件扩展名，其次用 mimeType 兜底。
   */
  private isAlreadyCompressed(
    name: string,
    mimeType?: string | null,
    extension?: string | null,
  ): boolean {
    const ext = (extension ?? name.split('.').pop() ?? '').toLowerCase();
    if (INCOMPRESSIBLE_EXTENSIONS.has(ext)) return true;

    const type = (mimeType ?? '').toLowerCase().trim();
    return (
      type.startsWith('video/') ||
      type.startsWith('audio/') ||
      type.startsWith('application/vnd.openxmlformats-officedocument.') ||
      INCOMPRESSIBLE_MIME_TYPES.has(type)
    );
  }

  private uniqueArchiveName(name: string, usedNames: Map<string, number>): string {
    const current = usedNames.get(name) ?? 0;
    usedNames.set(name, current + 1);
    if (current === 0) return name;

    const dotIndex = name.lastIndexOf('.');
    if (dotIndex <= 0) return `${name}-${current + 1}`;
    return `${name.slice(0, dotIndex)}-${current + 1}${name.slice(dotIndex)}`;
  }
}

/** `image/png; charset=binary` → `image/png` */
function normalizeMimeType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase();
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
