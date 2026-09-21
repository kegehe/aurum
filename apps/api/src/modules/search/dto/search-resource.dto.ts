import { PaginationDto } from '../../../common/dto/pagination.dto';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsArray,
  IsDateString,
  IsInt,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
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
 * 日期范围（ISO 8601 格式）
 */
export class DateRangeDto {
  @IsOptional()
  @IsDateString()
  start?: string;

  @IsOptional()
  @IsDateString()
  end?: string;
}

/**
 * 文件大小范围（bytes）
 */
export class SizeRangeDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  min?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  max?: number;
}

/**
 * 资源搜索查询 DTO（分页 + 关键词搜索 + 结构化筛选 + 排序）
 *
 * 替代原 QueryResourceDto，扩展了搜索范围和筛选能力：
 * - keyword 搜索范围扩展到 source、author、searchVector（提取文本）
 * - 新增日期范围筛选（createdAtRange、updatedAtRange）
 * - 新增文件大小范围筛选（sizeRange）
 * - 新增多类型/多分类筛选（resourceTypes、categoryIds）
 * - 保留单值字段（resourceType、categoryId）向后兼容
 */
export class SearchResourceDto extends PaginationDto {
  // ==================== 关键词搜索 ====================

  /** 关键词：搜索 title、originalFilename、description、source、author、searchVector */
  @IsOptional()
  @IsString()
  keyword?: string;

  // ==================== 结构化字段搜索 ====================

  /** 来源 contains 搜索 */
  @IsOptional()
  @IsString()
  source?: string;

  /** 作者 contains 搜索 */
  @IsOptional()
  @IsString()
  author?: string;

  // ==================== 类型筛选 ====================

  /** 单类型筛选（向后兼容） */
  @IsOptional()
  @IsEnum(ResourceType)
  resourceType?: ResourceType;

  /** 多类型筛选 */
  @IsOptional()
  @IsArray()
  @IsEnum(ResourceType, { each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
    return value;
  })
  resourceTypes?: ResourceType[];

  // ==================== 分类筛选 ====================

  /** 单分类筛选（向后兼容） */
  @IsOptional()
  @IsString()
  categoryId?: string;

  /** 多分类筛选 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value;
    return value;
  })
  categoryIds?: string[];

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  uncategorized?: boolean;

  // ==================== 日期范围 ====================

  /** 创建时间范围 */
  @IsOptional()
  @ValidateNested()
  @Type(() => DateRangeDto)
  createdAtRange?: DateRangeDto;

  /** 更新时间范围 */
  @IsOptional()
  @ValidateNested()
  @Type(() => DateRangeDto)
  updatedAtRange?: DateRangeDto;

  // ==================== 文件大小范围 ====================

  /** 文件大小范围（bytes） */
  @IsOptional()
  @ValidateNested()
  @Type(() => SizeRangeDto)
  sizeRange?: SizeRangeDto;

  // ==================== 布尔/枚举筛选 ====================

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  isFavorite?: boolean;

  @IsOptional()
  @IsEnum(ProcessingStatus)
  processingStatus?: ProcessingStatus;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  includeDeleted?: boolean;

  /** 仅返回回收站中的资源（deletedAt 非空） */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  deletedOnly?: boolean;

  // ==================== 获取模式筛选 ====================

  /** 按获取模式筛选（local_upload / link_only / metadata_only / archive_snapshot / mirror_file） */
  @IsOptional()
  @IsString()
  acquisitionMode?: string;

  // ==================== 排序 ====================

  @IsOptional()
  @IsEnum(ResourceSortField)
  sortBy?: ResourceSortField;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder;
}
