import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

/**
 * 更新资源元数据 DTO
 * 仅允许更新标题、描述、来源、作者、许可证备注、分类
 */
export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  /** 传 null 显式断开分类关联，传 UUID 设置新分类 */
  @IsOptional()
  @ValidateIf((o) => o.categoryId !== null)
  @IsNotEmpty()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  author?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  licenseNote?: string;
}
