import { IsOptional, IsString, MaxLength, Matches } from 'class-validator';

/** 创建标签 */
export class CreateTagDto {
  @IsString()
  @MaxLength(50)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex color like #ff0000' })
  color?: string;
}

/** 更新标签 */
export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be a hex color like #ff0000' })
  color?: string;
}
