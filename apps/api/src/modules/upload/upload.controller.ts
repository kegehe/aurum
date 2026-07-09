import {
  BadRequestException,
  Controller,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Request } from 'express';
import { UploadService } from './upload.service';
import { UploadResourceDto } from './dto/upload-resource.dto';

/**
 * 读取存储根目录（multer 装饰器在类定义时求值，无法访问注入的 ConfigService，
 * 直接读环境变量；ConfigModule 启动时也会校验这些变量）
 */
function getStorageRoot(): string {
  return process.env.STORAGE_ROOT || './storage';
}

function getMaxFileSize(): number {
  const mb = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '1024', 10);
  return mb * 1024 * 1024;
}

/**
 * 从 multipart 请求的 req.body 提取并校验 UploadResourceDto
 *
 * 注意：multipart/form-data 请求下，@Body() 装饰器拿不到 multer 解析的文本字段
 * （NestJS 在 multer 填充 req.body 前读取 @Body()）。因此通过 @Req().body 读取，
 * 再用 class-transformer + class-validator 手动校验。
 */
async function extractUploadDto(req: Request): Promise<UploadResourceDto> {
  const dto = plainToInstance(UploadResourceDto, req.body ?? {}, {
    enableImplicitConversion: true,
  });
  const errors = await validate(dto as Record<string, unknown>);
  if (errors.length > 0) {
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {})).join(', ');
    throw new BadRequestException(`Invalid upload metadata: ${messages}`);
  }
  return dto;
}

/**
 * 上传控制器
 *
 * Multer 使用 diskStorage 将上传文件先存到 storage/temp/{sessionId}/{randomId}.tmp，
 * 之后由 UploadService 计算 hash、移动到正式目录，避免大文件全部读入内存。
 */
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  /** 单文件上传 */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const sessionDir = join(getStorageRoot(), 'temp', randomUUID());
          mkdirSync(sessionDir, { recursive: true });
          cb(null, sessionDir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname);
          cb(null, `${randomUUID()}.tmp${ext}`);
        },
      }),
      limits: { fileSize: getMaxFileSize() },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File | undefined, @Req() req: Request) {
    if (!file) {
      throw new BadRequestException('No file uploaded (field name must be "file")');
    }
    const body = await extractUploadDto(req);
    return this.uploadService.handleUpload(file, body);
  }

  /** 批量上传 */
  @Post('batch')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const sessionDir = join(getStorageRoot(), 'temp', randomUUID());
          mkdirSync(sessionDir, { recursive: true });
          cb(null, sessionDir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname);
          cb(null, `${randomUUID()}.tmp${ext}`);
        },
      }),
      limits: { fileSize: getMaxFileSize() },
    }),
  )
  async uploadBatch(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Req() req: Request,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded (field name must be "files")');
    }
    const body = await extractUploadDto(req);
    return this.uploadService.handleBatchUpload(files, body);
  }
}
