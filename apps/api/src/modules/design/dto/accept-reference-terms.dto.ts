import { IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptReferenceTermsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  termsVersion!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  acceptedBy!: string;
}
