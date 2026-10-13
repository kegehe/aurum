import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DESIGN_KINDS, type DesignKind } from '../design.types';

export class ComposePreviewDto {
  @IsIn(DESIGN_KINDS)
  kind!: DesignKind;

  @IsObject()
  content!: Record<string, unknown>;

  /** 用哪套配色。外行只说"用哪套"，钉版本由服务端做。 */
  @IsOptional()
  @IsUUID()
  themeDocumentId?: string;

  /** 控件编辑：键是服务端下发的控件 key，值是选项值或数值。 */
  @IsOptional()
  @IsObject()
  edits?: Record<string, string | number>;
}

export class ComposePublishDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MaxLength(100)
  slug!: string;

  @IsIn(DESIGN_KINDS)
  kind!: DesignKind;

  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsUUID()
  themeDocumentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  summary?: string;
}

export class ComposeRecipeDto {
  @IsString()
  @MaxLength(100)
  recipeId!: string;

  /** 组件/动画配方需要一套配色来解析别名；配色配方不需要。 */
  @IsOptional()
  @IsUUID()
  themeDocumentId?: string;
}

export class ComposeGenerateDto {
  @IsIn(DESIGN_KINDS)
  kind!: DesignKind;

  @IsString()
  @MinLength(2)
  @MaxLength(2_000)
  intent!: string;

  /** 用哪套配色做基底 */
  @IsOptional()
  @IsUUID()
  themeDocumentId?: string;

  /** 从哪个效果配方起手。配色类资产必填。 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipeId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  count?: number;

  /** 图片/URL 参考档案（不可信数据，只作视觉意图） */
  @IsOptional()
  @IsObject()
  reference?: Record<string, unknown>;
}
