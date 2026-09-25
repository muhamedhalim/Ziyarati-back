import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import {
  WHATSAPP_ONBOARDING_TYPE,
  WHATSAPP_ONBOARDING_TYPES,
  type WhatsappOnboardingType,
} from '../whatsapp.constants';

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

  @ApiPropertyOptional({
    description:
      'STANDARD (default) — a normal managed Cloud API number — or COEXISTENCE, when the ' +
      'dialog completed via the WhatsApp Business App onboarding path (the frontend sets this ' +
      'from the `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` postMessage event, not from which button ' +
      'was clicked). This is a HINT for which onboarding branch to run (skip registration, kick off ' +
      'smb_app_data sync) — it is not trusted as proof of anything; the WABA/phone re-verification ' +
      'below applies identically regardless of its value.',
    enum: WHATSAPP_ONBOARDING_TYPES,
    default: WHATSAPP_ONBOARDING_TYPE.STANDARD,
    example: WHATSAPP_ONBOARDING_TYPE.COEXISTENCE,
  })
  @IsOptional()
  @IsIn(WHATSAPP_ONBOARDING_TYPES)
  onboardingType?: WhatsappOnboardingType;
}
