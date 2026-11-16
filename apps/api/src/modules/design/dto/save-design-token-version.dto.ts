import { IsObject, IsOptional, IsString } from 'class-validator';

export class SaveDesignTokenVersionDto {
  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  summary?: string;
}
