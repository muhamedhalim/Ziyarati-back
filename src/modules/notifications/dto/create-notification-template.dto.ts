import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_CHANNELS_LIST } from '../notification.constants';

/**
 * Creates a reusable notification template for the caller's tenant. The tenant
 * comes from the authenticated principal — there is no tenantId field.
 */
export class CreateNotificationTemplateDto {
  @ApiProperty({
    description: 'Human-readable template name (unique-ish per tenant by convention).',
    example: 'Appointment Reminder (24h)',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description:
      'Logical template type, e.g. `appointment_reminder`, `appointment_confirmation`, `review_request`, `payment_reminder`, `subscription_notice`, `staff_internal`.',
    example: 'appointment_reminder',
    maxLength: 50,
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({
    description: 'Delivery channel this template targets.',
    enum: NOTIFICATION_CHANNELS_LIST,
    example: 'WHATSAPP',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS_LIST)
  channel?: string;

  @ApiPropertyOptional({
    description: 'Arabic message body. May contain placeholders like `{{customerName}}`.',
    example: 'مرحباً {{customerName}}، نذكّرك بموعدك غداً الساعة {{time}}.',
  })
  @IsOptional()
  @IsString()
  contentAr?: string;

  @ApiPropertyOptional({
    description: 'English message body. May contain placeholders like `{{customerName}}`.',
    example: 'Hi {{customerName}}, a reminder of your appointment tomorrow at {{time}}.',
  })
  @IsOptional()
  @IsString()
  contentEn?: string;

  @ApiPropertyOptional({
    description: 'Whether the template is active and usable. Defaults to true.',
    example: true,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description:
      'For channel=WHATSAPP: the approved WhatsappTemplate id to send (default/fallback variant). Must belong to the caller\'s tenant.',
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000300',
  })
  @IsOptional()
  @IsUUID()
  providerTemplateId?: string;

  @ApiPropertyOptional({
    description:
      "M-10/CAP-I18N: optional Arabic-language sibling WhatsappTemplate (FR-H015 — connects template language selection to the recipient customer's locale choice). Its own `language` field must be Arabic. Must belong to the caller's tenant.",
    format: 'uuid',
    example: 'a1b2c3d4-0000-0000-0000-000000000301',
  })
  @IsOptional()
  @IsUUID()
  providerTemplateIdAr?: string;
}
