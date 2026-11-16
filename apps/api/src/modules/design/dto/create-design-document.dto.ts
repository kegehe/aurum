import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DESIGN_KINDS, type DesignKind } from '../design.types';

export class CreateDesignDocumentDto {
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
  @IsString()
  @MaxLength(500)
  summary?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
