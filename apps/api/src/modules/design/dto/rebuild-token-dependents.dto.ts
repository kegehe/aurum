import { IsArray, IsOptional, IsString } from 'class-validator';

export class RebuildTokenDependentsDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  documentIds?: string[];
}
