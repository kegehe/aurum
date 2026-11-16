import { IsArray, IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateDesignAssetDto {
  @IsObject()
  manifest!: Record<string, unknown>;

  @IsArray()
  files!: Array<Record<string, unknown>>;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
