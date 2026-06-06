import { IsString, MaxLength } from 'class-validator';

export class CreateVerificationDocumentDto {
  /** e.g. "commercial_registration", "national_id", "license". */
  @IsString()
  @MaxLength(100)
  docType!: string;

  /** URL of the already-uploaded file (upload handled by the storage layer). */
  @IsString()
  @MaxLength(1000)
  fileUrl!: string;
}
