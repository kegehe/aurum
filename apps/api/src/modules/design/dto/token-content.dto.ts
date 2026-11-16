import { IsObject } from 'class-validator';

export class TokenContentDto {
  @IsObject()
  content!: Record<string, unknown>;
}
