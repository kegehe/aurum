import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZipArchive } from 'archiver';
import { PassThrough, Readable } from 'node:stream';
import { ResourceRepository } from './repositories/resource.repository';
import { ResourceFileRepository } from '../file/repositories/resource-file.repository';
import { CategoryRepository } from '../category/repositories/category.repository';
import { IStorageService, STORAGE_SERVICE } from '../storage/interfaces/storage-service.interface';
import { IJobScheduler, JOB_SCHEDULER } from '../processing/interfaces/job-scheduler.interface';
import { SearchService } from '../search/search.service';
import { FileRole } from '../../common/constants/enums';
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

/**
 * 比较两个排序键值（用于相邻资源导航的确定性全序）。
 * NULL 视为最小值（与 SQLite 升序时 NULL 排最前一致）；
 * 支持 Date（createdAt/updatedAt）、bigint（sizeBytes）、string（title）。
 */
function compareSortKey(
  a: Date | bigint | string | null,
  b: Date | bigint | string | null,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  const ta = a instanceof Date ? a.getTime() : Number(a);
  const tb = b instanceof Date ? b.getTime() : Number(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

@Injectable()
export class ResourceService {
  constructor(
    private readonly resourceRepo: ResourceRepository,
    private readonly fileRepo: ResourceFileRepository,
    private readonly categoryRepo: CategoryRepository,
    @Inject(STORAGE_SERVICE) private readonly storage: IStorageService,
    @Inject(JOB_SCHEDULER) private readonly scheduler: IJobScheduler,
    private readonly searchService: SearchService,
  ) {}

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
    const serializedItems = items.map(({ locators, ...item }) => ({
      ...item,
      sizeBytes: item.sizeBytes.toString(),
      // External images have no generated local thumbnail. Prefer the source's
      // preview URL and fall back to its direct download URL for recognition.
      previewUrl:
        locators.find((locator) => locator.locatorType === 'preview')?.url ??
        locators.find((locator) => locator.locatorType === 'download')?.url ??
        null,
    }));

    return {
      items: serializedItems,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
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

    const keys = await this.resourceRepo.findSortKeys({ where, field: sortField });

    const direction = sortOrder === SortOrder.asc ? 1 : -1;
    keys.sort((a, b) => {
      const cmp = compareSortKey(a.sortKey, b.sortKey) * direction;
      if (cmp !== 0) return cmp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const index = keys.findIndex((key) => key.id === id);
    if (index === -1) {
      return { previousId: null, nextId: null, currentIndex: null, total: keys.length };
    }

    return {
      previousId: index > 0 ? keys[index - 1].id : null,
      nextId: index < keys.length - 1 ? keys[index + 1].id : null,
      currentIndex: index + 1,
      total: keys.length,
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
  }> {
    const resources = await this.resourceRepo.findActiveOriginalFiles(ids);
    const downloadableResources = resources.filter((resource) => resource.files.length > 0);
    if (downloadableResources.length === 0) {
      throw new NotFoundException('No downloadable resources found');
    }

    // 使用 zlib 默认 DEFLATE 压缩级别（level 6），仅对文本等可压缩内容生效；
    // 视频、图片、压缩包等已压缩格式通过每项 store: true 跳过压缩，避免大文件白白消耗 CPU。
    // 注意：不传 zlib 时 compress-commons 会默认到 Z_BEST_SPEED(1)，因此这里显式指定标准默认值。
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const output = new PassThrough();
    const usedNames = new Map<string, number>();
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);

    setImmediate(() => {
      void (async () => {
        try {
          for (const resource of downloadableResources) {
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
      missingResources: ids.length - downloadableResources.length,
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
   * 获取缩略图可读流
   * 如果缩略图尚未生成，返回 null
   */
  async getThumbnailFile(id: string): Promise<{
    stream: Readable;
    mimeType: string;
  } | null> {
    const resource = await this.resourceRepo.findById(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const thumbnailFile = await this.fileRepo.findByResourceAndRole(id, FileRole.thumbnail);
    if (!thumbnailFile) {
      return null;
    }
    const stream = await this.storage.getStream(thumbnailFile.storagePath);
    return {
      stream,
      mimeType: thumbnailFile.mimeType || 'image/webp',
    };
  }

  /** 软删除 */
  async softDelete(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.softDelete(id);
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 恢复 */
  async restore(id: string) {
    const existing = await this.resourceRepo.findById(id);
    if (!existing) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    const updated = await this.resourceRepo.restore(id);
    return { id: updated.id, deletedAt: updated.deletedAt };
  }

  /** 批量恢复：一次请求恢复多个回收站资源，并汇总未恢复成功的资源 */
  async batchRestore(ids: string[]) {
    const { restored, failedIds } = await this.resourceRepo.batchRestore(ids);
    return {
      resourceIds: ids,
      restored,
      failed: failedIds.length,
      failedResourceIds: failedIds,
    };
  }

  /** 彻底删除：清理磁盘文件和数据库记录。只允许删除已在回收站中的资源。 */
  async permanentDelete(id: string) {
    const resource = await this.resourceRepo.findByIdWithRelations(id);
    if (!resource) {
      throw new NotFoundException(`Resource ${id} not found`);
    }
    if (!resource.deletedAt) {
      throw new BadRequestException(`Resource ${id} is not in trash`);
    }

    await Promise.all(resource.files.map((file) => this.storage.delete(file.storagePath)));
    const deletedCount = await this.resourceRepo.deleteDeleted(id);

    return {
      id,
      deleted: deletedCount > 0,
      deletedFiles: resource.files.length,
    };
  }

  /** 清空回收站 */
  async emptyTrash() {
    const resources = await this.resourceRepo.findDeletedWithFiles();
    let deletedResources = 0;
    let deletedFiles = 0;
    let skippedResources = 0;
    for (const resource of resources) {
      const storagePaths = resource.files.map((file) => file.storagePath);
      // 删除存储文件（忽略已不存在的文件）
      await Promise.all(storagePaths.map((path) => this.storage.delete(path)));
      // 删除数据库记录（幂等：并发删除时 count=0 不报错）
      const count = await this.resourceRepo.deleteDeleted(resource.id);
      if (count > 0) {
        deletedResources++;
        deletedFiles += storagePaths.length;
      } else {
        // 记录已被并发请求删除
        skippedResources++;
      }
    }

    return {
      deletedResources,
      deletedFiles,
      skippedResources,
    };
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
