import { IsOptional, IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';

export class CreateLinkImportDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsUUID()
  sourceId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
