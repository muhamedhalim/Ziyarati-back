import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Non-file fields of the `multipart/form-data` request to
 * `POST /crm/customers/:customerId/files`. The binary itself arrives via the
 * `file` field, handled by `FileInterceptor` + `@UploadedFile()` — never
 * through this DTO.
 */
export class UploadCustomerFileDto {
  @ApiPropertyOptional({
    description:
      'Optional display name. Defaults to the sanitized original filename.',
    example: 'Lab result — 2026-06-01',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}
