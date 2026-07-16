import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  WHATSAPP_ACCOUNT_MODE,
  WHATSAPP_ACCOUNT_MODES,
} from '../whatsapp.constants';

/**
 * Creates a placeholder WhatsApp account slot for the caller's clinic.
 *
 * SECURITY — what this DTO deliberately does NOT accept:
 *   `accessToken`, `wabaId`, `phoneNumberId`.
 *
 * Those are established EXCLUSIVELY by Meta Embedded Signup
 * (`POST /whatsapp/onboarding/complete`), where the backend mints the credential
 * from a short-lived code and verifies with Meta that the token really controls
 * the WABA and number being claimed. Accepting them here would mean trusting the
 * client's word for both the credential and the ownership of a phone number —
 * the number that inbound webhooks use to decide which tenant a patient's
 * message belongs to. A permanent Meta token must never transit the frontend.
 *
 * The tenant comes from the authenticated principal — there is no tenantId.
 */
export class CreateWhatsappAccountDto {
  @ApiPropertyOptional({
    description:
      'Bind this account to a branch. Omit for a TENANT-LEVEL account usable by every branch.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description:
      'Account mode. `CUSTOM` = the clinic\'s own WhatsApp number (default). `PLATFORM` = a platform-provisioned account for this tenant (still tenant-owned; the platform operates no shared number).',
    enum: WHATSAPP_ACCOUNT_MODES,
    default: WHATSAPP_ACCOUNT_MODE.CUSTOM,
    example: WHATSAPP_ACCOUNT_MODE.CUSTOM,
  })
  @IsOptional()
  @IsIn(WHATSAPP_ACCOUNT_MODES)
  mode?: string;

  @ApiPropertyOptional({
    description:
      'Make this the clinic\'s default sending number. At most one default per clinic — setting this unsets the previous one.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the account is active. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
