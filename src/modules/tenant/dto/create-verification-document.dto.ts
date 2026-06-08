import { IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateVerificationDocumentDto {
  @ApiProperty({
    description:
      'Document category identifier. Common values: `commercial_registration` (CR certificate), `national_id` (owner ID), `license` (Ministry of Health license), `vat_certificate` (VAT registration), `medical_liability_insurance`.',
    example: 'commercial_registration',
    maxLength: 100,
  })
  /** e.g. "commercial_registration", "national_id", "license". */
  @IsString()
  @MaxLength(100)
  docType!: string;

  @ApiProperty({
    description:
      'URL of the already-uploaded document file. **Upload the file to your storage provider first** (S3, Cloudflare R2, etc.), then pass the resulting public or signed URL here. Maximum 1000 characters.',
    example: 'https://storage.example.com/tenant-docs/1010123456/cr-certificate.pdf',
    maxLength: 1000,
  })
  /** URL of the already-uploaded file (upload handled by the storage layer). */
  @IsString()
  @MaxLength(1000)
  fileUrl!: string;
}
