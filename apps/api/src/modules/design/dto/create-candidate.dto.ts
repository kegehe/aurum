import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCandidateDto {
  @IsString()
  @MaxLength(80)
  label!: string;

  @IsObject()
  content!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rationale?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  generationKey?: string;
}
