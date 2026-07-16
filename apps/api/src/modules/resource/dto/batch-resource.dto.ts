import { ArrayMinSize, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';

export class BatchResourceIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  resourceIds!: string[];
}

export class BatchTagResourcesDto extends BatchResourceIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  tagIds!: string[];
}

export class BatchCategoryResourcesDto extends BatchResourceIdsDto {
  /** 传 null 显式断开分类关联，传 UUID 设置新分类 */
  @IsOptional()
  @ValidateIf((o) => o.categoryId !== null)
  @IsNotEmpty()
  @IsUUID()
  categoryId?: string | null;
}

export class BatchFavoriteResourcesDto extends BatchResourceIdsDto {
  @IsBoolean()
  isFavorite!: boolean;
}
