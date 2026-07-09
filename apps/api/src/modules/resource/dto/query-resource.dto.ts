import { PaginationDto } from '../../../common/dto/pagination.dto';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { ResourceType, ProcessingStatus } from '../../../common/constants/enums';

/**
 * 资源排序字段
 */
export enum ResourceSortField {
  createdAt = 'createdAt',
  updatedAt = 'updatedAt',
  sizeBytes = 'sizeBytes',
  title = 'title',
}

export enum SortOrder {
  asc = 'asc',
  desc = 'desc',
}

/**
 * 资源列表查询 DTO（分页 + 筛选 + 排序）
 */
export class QueryResourceDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ResourceType)
  resourceType?: ResourceType;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  tagId?: string;

  @IsOptional()
  @IsBoolean()
  isFavorite?: boolean;

  @IsOptional()
  @IsEnum(ProcessingStatus)
  processingStatus?: ProcessingStatus;

  @IsOptional()
  @IsBoolean()
  includeDeleted?: boolean;

  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsEnum(ResourceSortField)
  sortBy?: ResourceSortField;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}
