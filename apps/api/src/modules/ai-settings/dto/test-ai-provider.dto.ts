import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { AI_PROVIDER_TYPES } from './create-ai-provider.dto';

const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * 连通性测试入参
 * 既可测「尚未保存」的临时配置，也可由保存的配置直接复用（此时由服务端带出密钥）。
 */
export class TestAiProviderDto {
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
  @IsString()
  @MaxLength(100)
  name?: string;
}
