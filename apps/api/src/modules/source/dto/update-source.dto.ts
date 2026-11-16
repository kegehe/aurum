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
  ValidateIf,
} from 'class-validator';
import { SourceType } from '../../../common/constants/enums';

export class UpdateSourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message:
      'slug must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen',
  })
  slug?: string;

  /** 传 null 清除 baseUrl，传新 URL 更新 */
  @IsOptional()
  @ValidateIf((o) => o.baseUrl !== null)
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  baseUrl?: string | null;

  @IsOptional()
  @IsIn(Object.values(SourceType))
  sourceType?: SourceType;

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

  /** 传 null 清除 termsUrl，传新 URL 更新 */
  @IsOptional()
  @ValidateIf((o) => o.termsUrl !== null)
  @IsUrl({ require_tld: false, require_protocol: true })
  termsUrl?: string | null;

  /** 传 null 清除 robotsUrl，传新 URL 更新 */
  @IsOptional()
  @ValidateIf((o) => o.robotsUrl !== null)
  @IsUrl({ require_tld: false, require_protocol: true })
  robotsUrl?: string | null;

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

  /** 定时自动同步间隔（小时）。传 null 关闭，传 1–168 设置每隔 N 小时自动拉取 */
  @IsOptional()
  @ValidateIf((o) => o.autoSyncIntervalHours !== null)
  @IsInt()
  @Min(1)
  @Max(168)
  autoSyncIntervalHours?: number | null;

  /**
   * 下载目录（相对存储根目录的子目录，如 `civitai/foo`）。
   * 传 null 清除（回到默认存储布局）。格式见 CreateSourceDto.downloadDirectory。
   */
  @IsOptional()
  @ValidateIf((o) => o.downloadDirectory !== null)
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/, {
    message:
      'downloadDirectory must be a relative subdirectory of letters/digits/_/- separated by / without leading/trailing slash',
  })
  downloadDirectory?: string | null;

  /** 同步下载的资源默认归入的资源库文件夹；传 null 清除 */
  @IsOptional()
  @ValidateIf((o) => o.downloadCategoryId !== null)
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  downloadCategoryId?: string | null;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return value;
  })
  @IsBoolean()
  requiresReview?: boolean;

  /** 传 null 清除 config，传新字符串更新 */
  @IsOptional()
  @ValidateIf((o) => o.config !== null)
  @IsString()
  config?: string | null;
}
