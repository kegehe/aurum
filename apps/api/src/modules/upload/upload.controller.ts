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
 * 修复 Multer/busboy 对非 ASCII 文件名的 latin1 误解码
 *
 * 问题：busboy 解析 multipart Content-Disposition 头时，对 filename 参数（非 filename*）
 * 使用 latin1 编码读取原始字节。当浏览器以 UTF-8 发送中文文件名时，UTF-8 字节被当作
 * latin1 逐字节解码，导致乱码（如 "中文.png" → "ä¸­æ–‡.png"）。
 *
 * 修复策略（三重验证，防止误判合法 Latin1 文件名）：
 * 1. 正则检测：originalname 中是否存在 UTF-8 起始字节 + 续字节的 Latin1 表现
 * 2. Round-trip 验证：修复结果用 UTF-8 编码再用 Latin1 解码，应能还原原始字符串
 * 3. Code point 验证：修复后必须包含至少一个 code point >= 0x800 的字符
 *    （即需要 UTF-8 3+ 字节编码的字符，如 CJK/假名/谚文/emoji）
 *    这排除了 2 字节 UTF-8 区块（Latin Extended/Greek/Cyrillic/Arabic/Hebrew 等）
 *    与合法 Latin1 字符组合的误判（如 "Ä§" 会被错误解码为 "Ħ"）
 *
 * 局限：西里尔/阿拉伯/希腊等 2 字节 UTF-8 语言的文件名乱码无法可靠修复，
 * 因为 2 字节 UTF-8 序列与合法 Latin1 字符组合在数学上不可区分。
 *
 * 参考：https://github.com/expressjs/multer/issues/1104
 */
function fixLatin1Filename(originalname: string): string {
  // 快速路径：纯 ASCII 无需修复
  if ([...originalname].every((c) => c.charCodeAt(0) < 0x80)) {
    return originalname;
  }

  // 检测是否包含 latin1 误解码的痕迹：连续高位字节
  // 0xC0-0xFF 是 UTF-8 起始字节在 latin1 中的表现，0x80-0xBF 是 UTF-8 续字节
  const hasLatin1Mojibake = /[\xC0-\xFF][\x80-\xBF]/.test(originalname);
  if (!hasLatin1Mojibake) {
    return originalname;
  }

  try {
    // 将 latin1 字符串转回原始字节，再以 UTF-8 解码
    const buf = Buffer.from(originalname, 'latin1');
    const fixed = buf.toString('utf8');

    // 修复结果与原值相同或包含无效字符（U+FFFD），不修复
    if (fixed === originalname || fixed.includes('�')) {
      return originalname;
    }

    // Round-trip 验证：修复结果用 UTF-8 编码再用 latin1 解码，应能还原原始字符串
    // 这确保 originalname 确实是 UTF-8 字节的 latin1 误解码
    const roundTrip = Buffer.from(fixed, 'utf8').toString('latin1');
    if (roundTrip !== originalname) {
      return originalname;
    }

    // Code point 验证：修复后必须包含至少一个 code point >= 0x800 的字符
    // （UTF-8 3+ 字节编码：CJK/假名/谚文/emoji 等）
    // 排除 2 字节 UTF-8 区块与合法 Latin1 字符组合的误判
    const hasHighCodePoint = [...fixed].some((c) => (c.codePointAt(0) ?? 0) >= 0x800);
    if (!hasHighCodePoint) {
      return originalname;
    }

    return fixed;
  } catch {
    // 解码失败，保持原值
  }

  return originalname;
}

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
      // 在 fileFilter 中修复 originalname，确保后续所有环节（filename 回调、UploadService）都拿到正确值
      fileFilter: (_req, file, cb) => {
        file.originalname = fixLatin1Filename(file.originalname);
        cb(null, true);
      },
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
      // 在 fileFilter 中修复 originalname，确保后续所有环节（filename 回调、UploadService）都拿到正确值
      fileFilter: (_req, file, cb) => {
        file.originalname = fixLatin1Filename(file.originalname);
        cb(null, true);
      },
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
