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

/** 将字符串 "true"/"false"/"1"/"0" 和数字 1/0 转换为布尔值；"null"/null 转为 null */
const ToTriBool = () =>
  Transform(({ value }) => {
    if (value === 'null' || value === null) return null;
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
    return value;
  });

/** 将字符串 "true"/"false"/"1"/"0" 和数字 1/0 转换为布尔值（不支持 null） */
const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === 'true' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 0 || value === '0') return false;
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

  /** 传 null 清除（回到"未设置"），传布尔值更新 */
  @IsOptional()
  @ToTriBool()
  @ValidateIf((o) => o.allowsCommercialUse !== null)
  @IsBoolean()
  allowsCommercialUse?: boolean | null;

  @IsOptional()
  @ToTriBool()
  @ValidateIf((o) => o.allowsRedistribution !== null)
  @IsBoolean()
  allowsRedistribution?: boolean | null;

  @IsOptional()
  @ToTriBool()
  @ValidateIf((o) => o.allowsDerivatives !== null)
  @IsBoolean()
  allowsDerivatives?: boolean | null;

  /** requiresAttribution 在 schema 中是 Boolean（非 nullable），不支持 null */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  requiresAttribution?: boolean;

  /** shareAlike 在 schema 中是 Boolean（非 nullable），不支持 null */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  shareAlike?: boolean;
}
