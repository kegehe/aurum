import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SourceType } from '../../../common/constants/enums';

export class CreateSourceDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message:
      'slug must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen',
  })
  slug!: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  baseUrl?: string;

  @IsIn(Object.values(SourceType))
  sourceType!: SourceType;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return value;
  })
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  allowedModes?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  termsUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  robotsUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerMinute?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60000)
  downloadIntervalMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrency?: number;

  /** 定时自动同步间隔（小时）。缺省 = 关闭，1–168 = 每隔 N 小时自动拉取 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  autoSyncIntervalHours?: number;

  /**
   * 下载目录（相对存储根目录的子目录，如 `civitai/foo`）。
   * 下载的原文件将落在 {downloadDirectory}/originals/… 下。
   * 由 `/` 分隔的若干目录段，每段为字母/数字/下划线/连字符；不允许 `..`、首尾斜杠、反斜杠、冒号或绝对路径，
   * 与存储驱动的防路径穿越规则保持一致。
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/, {
    message:
      'downloadDirectory must be a relative subdirectory of letters/digits/_/- separated by / without leading/trailing slash',
  })
  downloadDirectory?: string;

  /** 同步下载的资源默认归入的资源库文件夹（Category.id）；缺省 = 不归档 */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  downloadCategoryId?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return value;
  })
  @IsBoolean()
  requiresReview?: boolean;

  @IsOptional()
  @IsString()
  config?: string;
}
