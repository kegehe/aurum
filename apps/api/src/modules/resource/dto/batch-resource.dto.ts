import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

/**
 * 批量下载在没有 File System Access API 的浏览器里走原生表单提交，
 * 而 urlencoded 是「一个 ID 一个参数」，超过 body-parser 的参数条数上限（默认 1000）
 * 会直接 413。这里允许表单把 ID 用逗号拼成一个字段，JSON 路径（数组）保持不变。
 */
function splitIdList(value: unknown): unknown {
  return typeof value === 'string' ? value.split(',').filter(Boolean) : value;
}

export class BatchResourceIdsDto {
  @Transform(({ value }) => splitIdList(value))
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  resourceIds!: string[];
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
