import { IsArray, IsOptional, IsString } from 'class-validator';

export class SaveStudioSessionDto {
  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  files?: Array<Record<string, unknown>>;
}
