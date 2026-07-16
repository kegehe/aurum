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
} from 'class-validator';
import { SourceType } from '../../../common/constants/enums';

export class CreateSourceDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'slug must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen',
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
  @IsUUID()
  defaultLicenseId?: string;

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

  @IsOptional()
  @IsString()
  config?: string;
}
