import { IsString, IsUrl, IsUUID, MaxLength } from 'class-validator';

/** A reference must be tied to an operator-approved source registry entry. */
export class CreateUrlReferenceDraftDto {
  @IsUrl({ require_tld: false, require_protocol: true })
  @MaxLength(2048)
  url!: string;

  @IsUUID()
  sourceId!: string;
}
