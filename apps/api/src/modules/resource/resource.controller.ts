import {
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  Body,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { ResourceService } from './resource.service';
import { SearchResourceDto } from '../search/dto/search-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';
import {
  BatchCategoryResourcesDto,
  BatchFavoriteResourcesDto,
  BatchResourceIdsDto,
  BatchTagResourcesDto,
} from './dto/batch-resource.dto';

/**
 * 资源控制器
 *
 * 下载接口安全约束：
 * - 不接受客户端传入文件路径，只通过 resource_id 查 DB 取 storage_path
 * - storage.getStream 内部再次做路径穿越校验
 */
@Controller('resources')
export class ResourceController {
  constructor(private readonly resourceService: ResourceService) {}

  /** 资源列表（分页 + 搜索 + 筛选 + 排序） */
  @Get()
  list(@Query() query: SearchResourceDto) {
    return this.resourceService.findMany(query);
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

  /** 批量添加标签 */
  @Post('batch/tags/add')
  batchAddTags(@Body() dto: BatchTagResourcesDto) {
    return this.resourceService.batchAddTags(dto.resourceIds, dto.tagIds);
  }

  /** 批量移除标签 */
  @Post('batch/tags/remove')
  batchRemoveTags(@Body() dto: BatchTagResourcesDto) {
    return this.resourceService.batchRemoveTags(dto.resourceIds, dto.tagIds);
  }

  /** 资源详情（含文件、标签、去重提示） */
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

    // 流错误处理：防止 stream 出错时连接挂起
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ statusCode: 500, message: 'File read error' });
      }
    });
    res.on('close', () => {
      // 客户端断开时销毁流，释放资源（fs.ReadStream 继承自 Readable，有 destroy 方法）
      if (stream instanceof Readable) {
        stream.destroy();
      }
    });

    stream.pipe(res);
  }

  /** 原图内联预览（浏览器直接显示，不触发下载） */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Res() res: Response) {
    const { stream, mimeType, originalFilename } = await this.resourceService.getOriginalFile(id);
    const encodedName = encodeURIComponent(originalFilename);
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedName}`);
    // 允许浏览器缓存预览图 1 小时
    res.setHeader('Cache-Control', 'private, max-age=3600');

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

  /** 缩略图（WebP，用于卡片/列表展示） */
  @Get(':id/thumbnail')
  async thumbnail(@Param('id') id: string, @Res() res: Response) {
    const result = await this.resourceService.getThumbnailFile(id);
    if (!result) {
      // 区分"缩略图尚未生成"和"外链资源无缩略图"
      const resource = await this.resourceService.findBasicById(id);
      const isExternal = resource && resource.acquisitionMode && resource.acquisitionMode !== 'local_upload';
      res.status(404).json({
        statusCode: 404,
        message: isExternal ? 'No thumbnail for external link resource' : 'Thumbnail not yet generated',
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

  /** 软删除（进入回收站） */
  @Delete(':id')
  softDelete(@Param('id') id: string) {
    return this.resourceService.softDelete(id);
  }

  /** 清空回收站 */
  @Delete('trash/empty')
  emptyTrash() {
    return this.resourceService.emptyTrash();
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

  /** 为资源添加标签 */
  @Post(':id/tags/:tagId')
  addTag(@Param('id') id: string, @Param('tagId') tagId: string) {
    return this.resourceService.addTag(id, tagId);
  }

  /** 从资源移除标签 */
  @Delete(':id/tags/:tagId')
  removeTag(@Param('id') id: string, @Param('tagId') tagId: string) {
    return this.resourceService.removeTag(id, tagId);
  }
}
