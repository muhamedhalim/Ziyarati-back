import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Submit a verification document.
 *
 * Two delivery modes are accepted (the service requires exactly one source):
 *  - **R2 (preferred):** upload via `POST /uploads` first, then pass the
 *    returned `storageKey` + metadata here. The file stays in a private bucket.
 *  - **Legacy/external:** pass a `fileUrl` to an already-hosted document.
 */
export class CreateVerificationDocumentDto {
  @ApiProperty({
    description:
      'Document category identifier. Common values: `commercial_registration`, `national_id`, `license`, `vat_certificate`, `medical_liability_insurance`.',
    example: 'commercial_registration',
    maxLength: 100,
  })
  @IsString()
  @MaxLength(100)
  docType!: string;

  @ApiPropertyOptional({
    description:
      'Private storage object key returned by `POST /uploads`. Preferred over `fileUrl`. The object must already exist and belong to the caller\'s tenant.',
    example: 'a3f1.../commercial_registration/8c2e....pdf',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  storageKey?: string;

  @ApiPropertyOptional({
    description:
      'Legacy/external URL of an already-hosted document. Use only when not uploading via `POST /uploads`.',
    example: 'https://storage.example.com/tenant-docs/cr-certificate.pdf',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  fileUrl?: string;

  @ApiPropertyOptional({
    description: 'Original filename, shown in the review UI.',
    example: 'commercial-registration.pdf',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  originalFilename?: string;

  @ApiPropertyOptional({ example: 'application/pdf', maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiPropertyOptional({ description: 'File size in bytes.', example: 482133 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;

  @ApiPropertyOptional({
    description:
      'SHA-256 hex digest returned by `POST /uploads` — enables same-type dedup. Server-computed; echo it back unchanged.',
    example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sha256?: string;
}
