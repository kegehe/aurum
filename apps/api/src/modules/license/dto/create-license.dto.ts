import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateLicenseDto {
  /** SPDX 标识符，如 MIT、Apache-2.0。可选，自定义许可可不填 */
  @IsOptional()
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
