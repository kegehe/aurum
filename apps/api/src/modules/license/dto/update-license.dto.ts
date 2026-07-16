import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** 将字符串 "true"/"false" 和数字 1/0 转换为布尔值 */
const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return value;
  });

export class UpdateLicenseDto {
  /** 传 null 清除 spdxId，传新值更新；不允许空字符串 */
  @IsOptional()
  @ValidateIf((o) => o.spdxId !== null)
  @IsNotEmpty()
  @IsString()
  @MaxLength(50)
  spdxId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** 传 null 清除 url，传新 URL 更新 */
  @IsOptional()
  @ValidateIf((o) => o.url !== null)
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url?: string | null;

  /** 传 null 清除 text，传新文本更新 */
  @IsOptional()
  @ValidateIf((o) => o.text !== null)
  @IsString()
  text?: string | null;

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
