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
import { QueryResourceDto } from './dto/query-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';

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

  /** 资源列表（分页 + 筛选 + 排序） */
  @Get()
  list(@Query() query: QueryResourceDto) {
    return this.resourceService.findMany(query);
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

  /** 软删除（进入回收站） */
  @Delete(':id')
  softDelete(@Param('id') id: string) {
    return this.resourceService.softDelete(id);
  }

  /** 从回收站恢复 */
  @Post(':id/restore')
  restore(@Param('id') id: string) {
    return this.resourceService.restore(id);
  }
}
