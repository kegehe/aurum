import { ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

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
  @IsOptional()
  @IsString()
  categoryId?: string | null;
}

export class BatchFavoriteResourcesDto extends BatchResourceIdsDto {
  @IsBoolean()
  isFavorite!: boolean;
}
