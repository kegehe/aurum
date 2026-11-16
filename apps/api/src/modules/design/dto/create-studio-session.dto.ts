import { IsString } from 'class-validator';

export class CreateStudioSessionDto {
  @IsString()
  assetId!: string;
}
