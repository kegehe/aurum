import { ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

/** 创建集合 */
export class CreateCollectionDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  coverResourceId?: string;
}

/** 更新集合 */
export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  coverResourceId?: string | null;
}

/** 批量添加资源到集合 */
export class BatchAddResourcesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  resourceIds!: string[];
}
