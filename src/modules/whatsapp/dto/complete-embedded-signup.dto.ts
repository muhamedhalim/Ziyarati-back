import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Completes Meta Embedded Signup for the caller's clinic.
 *
 * Note what is NOT here: an access token. The browser only ever receives a
 * SHORT-LIVED authorization code from Meta's dialog; the backend exchanges it
 * for the real credential using the platform app secret. A permanent Meta token
 * must never transit the frontend, so there is no field to submit one.
 *
 * `wabaId` / `phoneNumberId` come from the dialog and are therefore UNTRUSTED
 * input — the backend re-reads both from Meta with the exchanged token and
 * rejects anything the token cannot actually control (see
 * MetaEmbeddedSignupService). They are accepted only to identify WHICH assets
 * the user picked, never as proof of ownership.
 *
 * The tenant is taken from the authenticated principal — there is no tenantId.
 */
export class CompleteEmbeddedSignupDto {
  @ApiProperty({
    description:
      'The short-lived authorization code returned by the Meta Embedded Signup dialog. ' +
      'Single-use; exchanged server-side for the account credential.',
    example: 'AQBxyz...redacted',
  })
  @IsString()
  @MaxLength(1024)
  code!: string;

  @ApiProperty({
    description:
      'WhatsApp Business Account id selected in the dialog. Re-validated against Meta with the exchanged token — never trusted as-is.',
    example: '102290129340398',
  })
  @IsString()
  @MaxLength(100)
  wabaId!: string;

  @ApiPropertyOptional({
    description:
      'Phone number id selected in the dialog. Optional when the WABA has exactly one number (it is then used automatically); required when it has several, since the platform will not guess which identity the clinic sends from.',
    example: '106540352242922',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  phoneNumberId?: string;

  @ApiPropertyOptional({
    description:
      'Meta Business (portfolio) id, for diagnostics. Overridden by the value Meta reports for the WABA when available.',
    example: '1234567890',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  metaBusinessId?: string;

  @ApiPropertyOptional({
    description:
      'Bind this number to a specific branch. Omit for a TENANT-LEVEL number usable by every branch (the common case for a single-number clinic).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
