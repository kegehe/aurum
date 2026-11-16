import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class SaveDesignAssetVersionDto {
  @IsArray()
  files!: Array<Record<string, unknown>>;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsBoolean()
  publish?: boolean;

  /** 调用方看到的正式版本 id；用于并发保存时拒绝覆盖别人的新版本 */
  @IsOptional()
  @IsString()
  baseVersionId?: string;
}
