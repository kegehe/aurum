import { IsOptional, IsString, MaxLength } from 'class-validator';

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

  @IsOptional()
  @IsString()
  categoryId?: string;

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
