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

/** 当前支持的供应商类型（均为 Anthropic 兼容接口） */
export const AI_PROVIDER_TYPES = ['anthropic'] as const;

/** 空字符串转 undefined，避免 IsUrl 对可选字段的空串报错 */
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === 1 || value === true;

export class CreateAiProviderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsIn(AI_PROVIDER_TYPES)
  provider?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  baseUrl?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  apiKey!: string;

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
