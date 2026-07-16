import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateLicenseDto {
  /** 传 null 清除 spdxId，传新值更新 */
  @IsOptional()
  @ValidateIf((o) => o.spdxId !== null)
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
  @IsBoolean()
  allowsCommercialUse?: boolean;

  @IsOptional()
  @IsBoolean()
  allowsRedistribution?: boolean;

  @IsOptional()
  @IsBoolean()
  allowsDerivatives?: boolean;

  @IsOptional()
  @IsBoolean()
  requiresAttribution?: boolean;

  @IsOptional()
  @IsBoolean()
  shareAlike?: boolean;
}
