import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/** 将字符串 "true"/"false"/"1"/"0" 和数字 1/0 转换为布尔值 */
const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return value;
  });

export class CreateLicenseDto {
  /** SPDX 标识符，如 MIT、Apache-2.0。可选，自定义许可可不填；不允许空字符串 */
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  spdxId?: string;

  @IsString()
  @MaxLength(200)
  name!: string;

  /** 许可证全文或摘要的 URL */
  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url?: string;

  /** 许可证全文 */
  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  allowsCommercialUse?: boolean;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  allowsRedistribution?: boolean;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  allowsDerivatives?: boolean;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  requiresAttribution?: boolean;

  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  shareAlike?: boolean;
}
