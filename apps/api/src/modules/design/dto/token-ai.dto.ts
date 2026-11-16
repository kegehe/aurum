import { IsObject, IsString } from 'class-validator';

export class TokenAiDto {
  @IsObject()
  content!: Record<string, unknown>;

  @IsString()
  request!: string;
}
