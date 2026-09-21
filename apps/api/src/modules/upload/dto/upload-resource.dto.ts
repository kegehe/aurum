import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * 上传资源时可填写的元数据
 * 文件本身通过 multipart 的 file 字段上传，这里只接收元数据
 */
export class UploadResourceDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  author?: string;
}
