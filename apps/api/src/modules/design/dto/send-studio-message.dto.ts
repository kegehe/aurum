import { IsString } from 'class-validator';

export class SendStudioMessageDto {
  @IsString()
  content!: string;
}
