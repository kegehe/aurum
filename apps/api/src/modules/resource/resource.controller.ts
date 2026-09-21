import { Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, Body } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { ResourceService } from './resource.service';
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
  constructor(private readonly resourceService: ResourceService) {}

  /** 资源列表（分页 + 搜索 + 筛选 + 排序） */
  @Get()
  list(@Query() query: SearchResourceDto) {
    return this.resourceService.findMany(query);
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
    pipeStream(stream, res);
  }

  /**
   * 原文件内联预览（浏览器直接显示，不触发下载）
   * 支持 HTTP Range 请求（视频/音频 seek 必需）：返回 206 部分内容
   */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const { mimeType, originalFilename, sizeBytes } =
      await this.resourceService.getOriginalFileInfo(id);
    const encodedName = encodeURIComponent(originalFilename);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
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
      const stream = await this.resourceService.getOriginalFileRange(id, range.start, range.end);
      res.status(206);
      res.setHeader('Content-Type', mimeType || 'application/octet-stream');
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      pipeStream(stream, res);
      return;
    }

    // 完整内容
    const { stream } = await this.resourceService.getOriginalFile(id);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(sizeBytes));
    pipeStream(stream, res);
  }

  /** 缩略图（WebP，用于卡片/列表展示） */
  @Get(':id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() res: Response) {
    const result = await this.resourceService.getThumbnailFile(id);
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

    const { stream, mimeType } = result;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', 'inline');
    // 缩略图变化频率低，缓存 24 小时
    res.setHeader('Cache-Control', 'private, max-age=86400');

    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ statusCode: 500, message: 'File read error' });
      }
    });
    res.on('close', () => {
      if (stream instanceof Readable) {
        stream.destroy();
      }
    });

    stream.pipe(res);
  }

  /** 清空回收站（必须在 @Delete(':id') 之前声明，否则 :id 会先匹配 "trash"） */
  @Delete('trash/empty')
  emptyTrash() {
    return this.resourceService.emptyTrash();
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
