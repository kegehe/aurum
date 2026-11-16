import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { StyleService } from './style.service';

/** 样式图片上传上限（MB），与 upload 模块一致：装饰器在类定义时求值，直接读环境变量 */
function getMaxStyleImageSize(): number {
  const mb = parseInt(process.env.MAX_STYLE_IMAGE_SIZE_MB || '20', 10);
  return mb * 1024 * 1024;
}

@Controller('style')
export class StyleController {
  constructor(private readonly styleService: StyleService) {}

  /** AI 功能可用性（前端据此决定是否启用入口、以及提示「未配置」还是「临时降级」） */
  @Get('health')
  health() {
    return this.styleService.availability;
  }

  /**
   * 清除 AI 降级缓存（前端「立即重试 AI」）。
   * 降级窗口内重试不会自动再调 AI，这里给用户一个显式跳过的入口。
   */
  @Post('ai-retry')
  @HttpCode(200)
  retryAi() {
    this.styleService.resetAiFailure();
    return this.styleService.availability;
  }

  /**
   * 样式分析
   *
   * multipart 字段名 `image`。使用 memoryStorage（图片较小，上限默认 20MB），
   * 由 StyleService 用 sharp 校验图片有效性并提取色板。
   */
  @Post('analyze')
  @UseInterceptors(
    FileInterceptor('image', {
      storage: memoryStorage(),
      limits: { fileSize: getMaxStyleImageSize() },
    }),
  )
  async analyze(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('请上传图片（multipart 字段名必须是 image）');
    }
    return this.styleService.analyze(file);
  }
}
