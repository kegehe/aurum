import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

/**
 * 更新资源元数据 DTO
 * 仅允许更新标题、描述、来源、作者、分类
 */
export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  /** 传 null 清除描述，传新值更新；不允许空字符串 */
  @IsOptional()
  @ValidateIf((o) => o.description !== null)
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** 传 null 显式断开分类关联，传 UUID 设置新分类 */
  @IsOptional()
  @ValidateIf((o) => o.categoryId !== null)
  @IsNotEmpty()
  @IsUUID()
  categoryId?: string | null;

  /** 传 null 清除来源，传新值更新；不允许空字符串 */
  @IsOptional()
  @ValidateIf((o) => o.source !== null)
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  source?: string | null;

  /** 传 null 清除作者，传新值更新；不允许空字符串 */
  @IsOptional()
  @ValidateIf((o) => o.author !== null)
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  author?: string | null;
}
