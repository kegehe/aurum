import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class GenerateAiCandidatesDto {
  @IsString()
  @MaxLength(2000)
  intent!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  count?: number;
}
