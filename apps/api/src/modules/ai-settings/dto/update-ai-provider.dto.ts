import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AI_PROVIDER_TYPES } from './create-ai-provider.dto';

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === 1 || value === true;

export class UpdateAiProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(AI_PROVIDER_TYPES)
  provider?: string;

  /** null 表示清除自定义地址回到官方默认；空串同样视为清除 */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  baseUrl?: string | null;

  /** 掩码值或空串表示不修改现有密钥 */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isActive?: boolean;
}
