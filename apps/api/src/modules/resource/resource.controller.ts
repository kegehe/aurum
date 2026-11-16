import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  Body,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { ResourceService } from './resource.service';
import { FileRole } from '../../common/constants/enums';
import { SearchResourceDto } from '../search/dto/search-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';
import {
  BatchCategoryResourcesDto,
  BatchFavoriteResourcesDto,
  BatchResourceIdsDto,
} from './dto/batch-resource.dto';

/**
 * 资源控制器
 *
 * 下载接口安全约束：
 * - 不接受客户端传入文件路径，只通过 resource_id 查 DB 取 storage_path
 * - storage.getStream 内部再次做路径穿越校验
 */

/** 统一流式响应：错误处理 + 客户端断开时销毁流，防止连接挂起 */
function pipeStream(stream: Readable, res: Response) {
  stream.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ statusCode: 500, message: 'File read error' });
    } else {
      // 响应头已发出后流出错：关闭连接，避免客户端挂起等待
      res.destroy();
    }
  });
  res.on('close', () => {
    if (stream instanceof Readable) {
      stream.destroy();
    }
  });
  stream.pipe(res);
}

/**
 * 可在文档上下文里执行脚本的 MIME 类型。
 * 远端抓取或用户上传的 HTML / XML / SVG 都属于不可信内容，内联分发等于在我们的
 * 源上开存储型 XSS：直接打开预览地址就能用本站身份调用同源接口。
 */
const UNSAFE_INLINE_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'image/svg+xml',
  // 非标准写法：部分客户端 / 远端响应会这样声明
  'image/svg',
  'text/svg+xml',
  'application/svg+xml',
]);

/**
 * 即使 MIME 声称安全，这些扩展名也不内联。
 * MIME 可能来自上传方或远端响应头，不能单独信任：file-type 认不出 SVG 的魔数，
 * 上传时最终落库的正是客户端声明的类型，因此扩展名要再兜一层。
 */
const UNSAFE_INLINE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml', 'svg', 'svgz']);

/** 判断该文件是否只能以附件形式分发（不可内联渲染） */
function isUnsafeInline(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const baseType = (mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (UNSAFE_INLINE_MIME_TYPES.has(baseType)) return true;

  const name = filename || '';
  const dot = name.lastIndexOf('.');
  const extension =
    dot >= 0
      ? name
          .slice(dot + 1)
          .trim()
          .toLowerCase()
      : '';
  return UNSAFE_INLINE_EXTENSIONS.has(extension);
}

/**
 * 附件分发之外再补一层 CSP 沙箱：即使某个浏览器忽略 Content-Disposition
 * 直接渲染，脚本执行与外部资源加载也会被禁止，避免 SVG/HTML 借本站源执行。
 * 返回是否为不可信内容（调用方据此决定 inline / attachment）。
 */
function applyUnsafeContentGuards(
  res: Response,
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): boolean {
  const unsafe = isUnsafeInline(mimeType, filename);
  if (unsafe) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
  return unsafe;
}

/** 预览缩放边长的合法区间：太小没意义，太大就把原图问题又带回来了 */
const MIN_PREVIEW_MAX_EDGE = 512;
const MAX_PREVIEW_MAX_EDGE = 4096;

/**
 * 解析 ?max= 参数；非法值按"不缩放"处理，回退原图。
 * 取值吸附到 512 的整数倍：避免同一张图被任意 max 拆成上千份缓存、反复重编码。
 */
function parsePreviewMax(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  // 非法或过小的值按"不缩放"处理，而不是偷偷放大到最小档
  if (!Number.isFinite(value) || value < MIN_PREVIEW_MAX_EDGE) return null;
  const clamped = Math.min(MAX_PREVIEW_MAX_EDGE, Math.round(value));
  return Math.ceil(clamped / 512) * 512;
}

type RangeParseResult = { satisfiable: true; start: number; end: number } | { satisfiable: false };

/**
 * 解析 HTTP Range 请求头（仅支持单区间 bytes=start-end / bytes=-suffix）
 * 返回 null 表示无 Range 或无法解析（回退完整 200 响应）
 * start >= size 时返回 satisfiable=false（调用方应回 416）
 */
function parseRangeHeader(header: string | undefined, size: number): RangeParseResult | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith('bytes=')) return null;
  // 多区间不支持，回退完整响应
  if (trimmed.includes(',')) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match) return null;
  const [, startStr, endStr] = match;

  let start: number;
  let end: number;
  if (startStr === '') {
    // 后缀范围 bytes=-N：最后 N 字节
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return null;
    end = endStr === '' ? size - 1 : Number(endStr);
    if (!Number.isInteger(end)) return null;
  }

  if (start >= size) return { satisfiable: false };
  if (end < start) return null;
  if (end >= size) end = size - 1;
  return { satisfiable: true, start, end };
}

@Controller('resources')
export class ResourceController {
  private readonly logger = new Logger(ResourceController.name);

  constructor(private readonly resourceService: ResourceService) {}

  /** 资源列表（分页 + 搜索 + 筛选 + 排序） */
  @Get()
  list(@Query() query: SearchResourceDto) {
    return this.resourceService.findMany(query);
  }

  /**
   * 当前筛选范围内的全部资源 ID（不分页，供前端“全选当前目录”）。
   * 必须声明在 @Get(':id') 之前，否则 "ids" 会被当作资源 ID 匹配。
   */
  @Get('ids')
  listIds(@Query() query: SearchResourceDto) {
    return this.resourceService.findIds(query);
  }

  /** 相邻资源导航：在相同筛选/排序上下文中返回上一个/下一个资源 ID */
  @Get(':id/neighbors')
  neighbors(@Param('id') id: string, @Query() query: SearchResourceDto) {
    return this.resourceService.findNeighbors(id, query);
  }

  /** 批量下载原文件 ZIP */
  @Post('batch/download')
  async batchDownload(@Body() dto: BatchResourceIdsDto, @Res() res: Response) {
    const { stream, filename, foundResources, missingResources } =
      await this.resourceService.createBatchDownload(dto.resourceIds);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Resource-Found-Count', String(foundResources));
    res.setHeader('X-Resource-Missing-Count', String(missingResources));

    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ statusCode: 500, message: 'Archive generation failed' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (stream instanceof Readable) {
        stream.destroy();
      }
    });

    stream.pipe(res);
  }

  /** 批量设置分类 */
  @Post('batch/category')
  batchSetCategory(@Body() dto: BatchCategoryResourcesDto) {
    return this.resourceService.batchSetCategory(dto.resourceIds, dto.categoryId ?? null);
  }

  /** 批量收藏/取消收藏 */
  @Post('batch/favorite')
  batchSetFavorite(@Body() dto: BatchFavoriteResourcesDto) {
    return this.resourceService.batchSetFavorite(dto.resourceIds, dto.isFavorite);
  }

  /** 批量软删除 */
  @Post('batch/delete')
  batchSoftDelete(@Body() dto: BatchResourceIdsDto) {
    return this.resourceService.batchSoftDelete(dto.resourceIds);
  }

  /** 批量从回收站恢复 */
  @Post('batch/restore')
  batchRestore(@Body() dto: BatchResourceIdsDto) {
    return this.resourceService.batchRestore(dto.resourceIds);
  }

  /** 资源详情（含文件、去重提示） */
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.resourceService.findById(id);
  }

  /** 更新资源元数据 */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateResourceDto) {
    return this.resourceService.update(id, dto);
  }

  /** 下载原文件 */
  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const { stream, mimeType, originalFilename } = await this.resourceService.getOriginalFile(id);
    // 文件名用 RFC 5987 编码，支持中文等非 ASCII 字符
    const encodedName = encodeURIComponent(originalFilename);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    applyUnsafeContentGuards(res, mimeType, originalFilename);
    pipeStream(stream, res);
  }

  /**
   * 下载派生文件（页面快照 / 缩略图 / 提取文本 / 转码）
   *
   * 角色名走白名单且不参与路径拼接；一律 attachment 分发 —— 快照是不可信的
   * 远端 HTML，内联分发等于在我们的源上执行它的脚本。
   */
  @Get(':id/files/:role/download')
  async downloadDerived(
    @Param('id') id: string,
    @Param('role') role: string,
    @Res() res: Response,
  ) {
    const allowed: string[] = [
      FileRole.snapshot,
      FileRole.thumbnail,
      FileRole.preview,
      FileRole.extracted_text,
      FileRole.transcode,
    ];
    if (!allowed.includes(role)) {
      throw new BadRequestException(`Unsupported derived file role: ${role}`);
    }
    const { stream, mimeType, originalFilename } = await this.resourceService.getDerivedFile(
      id,
      role as Exclude<FileRole, FileRole.original>,
    );
    const encodedName = encodeURIComponent(originalFilename);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    applyUnsafeContentGuards(res, mimeType, originalFilename);
    pipeStream(stream, res);
  }

  /**
   * 原文件内联预览（浏览器直接显示，不触发下载）
   * 支持 HTTP Range 请求（视频/音频 seek 必需）：返回 206 部分内容
   *
   * HTML/XHTML/XML 以及 SVG 这类可在文档上下文里执行脚本的内容不在此列：远端
   * 抓取或用户上传的它们都属于不可信内容，内联分发等于在我们的源上开存储型
   * XSS（SVG 直接打开时 <script>/onload 会以本站身份运行）。
   * 这类文件一律降级为附件下载（实施方案 §7 的不可信预览隔离要求）。
   */
  @Get(':id/preview')
  async preview(
    @Param('id') id: string,
    @Query('max') max: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // 详情页大图先走缩放预览：43MB / 3232×5760 的原图直接内联会让浏览器解码上千毫秒。
    // 非图片、动图、尺寸本来就小的资源返回 null，继续走下面的原图分支。
    const maxEdge = parsePreviewMax(max);
    if (maxEdge) {
      const resized = await this.resourceService.getResizedPreview(id, maxEdge);
      if (resized) {
        // 缩放产物是 WebP，保存时的文件名也换成 .webp，避免扩展名与内容不一致
        const extensionAt = resized.originalFilename.lastIndexOf('.');
        const baseName =
          extensionAt > 0
            ? resized.originalFilename.slice(0, extensionAt)
            : resized.originalFilename;
        const encodedResizedName = encodeURIComponent(`${baseName}.webp`);
        res.setHeader('Content-Type', resized.mimeType);
        res.setHeader('Content-Length', String(resized.buffer.byteLength));
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedResizedName}`);
        res.end(resized.buffer);
        return;
      }
    }

    let fileInfo: { mimeType: string; originalFilename: string; sizeBytes: number };
    try {
      fileInfo = await this.resourceService.getOriginalFileInfo(id);
    } catch (error) {
      // 原文件记录被删/从未落库：和流读取失败一样降级到缩略图，别让整个资源 404。
      if (error instanceof NotFoundException) return this.serveThumbnail(id, req, res);
      throw error;
    }
    const { mimeType, originalFilename, sizeBytes } = fileInfo;
    const encodedName = encodeURIComponent(originalFilename);
    // MIME 与扩展名任一命中不可信类型即降级为附件：两者都不是可信来源，
    // 只看 MIME 会漏掉 MIME 声明错误 / 缺失的 SVG。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    const unsafeInline = applyUnsafeContentGuards(res, mimeType, originalFilename);
    res.setHeader(
      'Content-Disposition',
      `${unsafeInline ? 'attachment' : 'inline'}; filename*=UTF-8''${encodedName}`,
    );
    // 允许浏览器缓存预览 1 小时
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const range = parseRangeHeader(req.headers.range, sizeBytes);

    // 无效范围（start 超出文件大小）→ 416
    if (range && !range.satisfiable) {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${sizeBytes}`);
      res.json({ statusCode: 416, message: 'Range Not Satisfiable' });
      return;
    }

    // 范围请求 → 206 部分内容（视频/音频 seek）
    if (range) {
      let stream: Readable;
      try {
        stream = await this.resourceService.getOriginalFileRange(id, range.start, range.end);
      } catch (error) {
        // 原文件记录还在但磁盘文件丢了：能缩略图就缩略图，别让详情页整块裂掉。
        if (error instanceof NotFoundException) return this.serveThumbnail(id, req, res);
        throw error;
      }
      res.status(206);
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      pipeStream(stream, res);
      return;
    }

    // 完整内容
    let stream: Readable;
    try {
      stream = (await this.resourceService.getOriginalFile(id)).stream;
    } catch (error) {
      if (error instanceof NotFoundException) return this.serveThumbnail(id, req, res);
      throw error;
    }
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(sizeBytes));
    pipeStream(stream, res);
  }

  /** 原文件缺失时的降级输出：缩略图；缩略图也没有才 404。 */
  private async serveThumbnail(id: string, req: Request, res: Response): Promise<void> {
    const thumbnail = await this.resourceService.getThumbnailFile(id, req.headers['if-none-match']);
    if (!thumbnail) {
      throw new NotFoundException('Original file missing and no thumbnail available');
    }
    if (thumbnail.notModified) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', thumbnail.mimeType);
    res.setHeader('ETag', thumbnail.etag);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    pipeStream(thumbnail.stream, res);
  }

  /** 缩略图（WebP，用于卡片/列表展示） */
  @Get(':id/thumbnail')
  async thumbnail(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const result = await this.resourceService.getThumbnailFile(id, req.headers['if-none-match']);
    if (!result) {
      // 区分"缩略图尚未生成"和"外链资源无缩略图"
      const resource = await this.resourceService.findBasicById(id);
      const isExternal =
        resource && resource.acquisitionMode && resource.acquisitionMode !== 'local_upload';
      res.status(404).json({
        statusCode: 404,
        message: isExternal
          ? 'No thumbnail for external link resource'
          : 'Thumbnail not yet generated',
      });
      return;
    }

    // 缩略图变化频率低，缓存 24 小时；ETag 让重复访问走 304，不用再读文件
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('ETag', result.etag);
    if (result.notModified) {
      res.status(304).end();
      return;
    }

    const { stream, mimeType } = result;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    // 与原图下载共用：响应头已经发出后读盘失败要毁掉连接，否则卡片会一直等到超时
    pipeStream(stream, res);
  }

  /** 回收站统计：资源数 / 文件数 / 占用字节（供页面展示与清空确认使用） */
  @Get('trash/stats')
  trashStats() {
    return this.resourceService.getTrashStats();
  }

  /** 清空回收站（必须在 @Delete(':id') 之前声明，否则 :id 会先匹配 "trash"） */
  @Delete('trash/empty')
  emptyTrash() {
    return this.resourceService.emptyTrash();
  }

  /**
   * 清空回收站（SSE 进度流）
   *
   * 彻底删除可能涉及大量磁盘文件，一次性请求只能等到全部完成才返回。
   * 这里按资源逐条推送 progress 事件，前端可展示进度条与已删除数量；
   * 结束时推送 done（含最终统计），失败推送 error。
   * 客户端断开只停止推送，服务端仍会继续清理到结束，避免半删除状态。
   */
  @Post('trash/empty/stream')
  async emptyTrashStream(@Req() req: Request, @Res() res: Response) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    const onClose = () => {
      closed = true;
    };
    req.on('close', onClose);
    res.on('close', onClose);

    const send = (event: string, data: unknown) => {
      if (closed || res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const result = await this.resourceService.emptyTrash({
        onProgress: (progress) => send('progress', progress),
      });
      send('done', result);
    } catch (error) {
      // 原始 message 可能带磁盘路径/Prisma 细节，只进日志，不回给浏览器。
      this.logger.error(
        `清空回收站失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      send('error', { message: '清空回收站失败，请稍后重试' });
    } finally {
      req.off('close', onClose);
      res.off('close', onClose);
      if (!res.writableEnded) res.end();
    }
  }

  /** 软删除（进入回收站） */
  @Delete(':id')
  softDelete(@Param('id') id: string) {
    return this.resourceService.softDelete(id);
  }

  /** 彻底删除（仅限回收站内资源） */
  @Delete(':id/permanent')
  permanentDelete(@Param('id') id: string) {
    return this.resourceService.permanentDelete(id);
  }

  /** 从回收站恢复 */
  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.resourceService.restore(id);
  }

  /** 重新处理资源（重新检测元数据、生成缩略图/封面等） */
  @Post(':id/reprocess')
  reprocess(@Param('id') id: string) {
    return this.resourceService.reprocess(id);
  }
}
