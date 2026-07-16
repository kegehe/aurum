import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
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
    message: 'slug must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen',
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

  /** 传 null 清除 defaultLicenseId，传新 UUID 更新 */
  @IsOptional()
  @ValidateIf((o) => o.defaultLicenseId !== null)
  @IsUUID()
  defaultLicenseId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  rateLimitPerMinute?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrency?: number;

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
