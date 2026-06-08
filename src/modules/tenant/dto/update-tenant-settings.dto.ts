import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({
    description:
      '`AUTO` — bookings are confirmed instantly without staff intervention. `MANUAL` — each booking requires explicit approval by a staff member.',
    enum: ['AUTO', 'MANUAL'],
    example: 'AUTO',
  })
  /** How bookings are confirmed: automatically or manually by staff. */
  @IsOptional()
  @IsIn(['AUTO', 'MANUAL'])
  bookingConfirmation?: string;

  @ApiPropertyOptional({
    description: 'Whether payment is required to confirm a booking.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  paymentRequired?: boolean;

  @ApiPropertyOptional({
    description:
      'Number of hours before the appointment within which cancellation is blocked. 0 = always allowed. Maximum 720 hours (30 days).',
    minimum: 0,
    maximum: 720,
    example: 24,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(720) // up to 30 days
  cancellationHours?: number;

  @ApiPropertyOptional({
    description:
      'Minutes after an appointment before the post-visit feedback request is sent. Default 360 (6 hours). Maximum 10080 (7 days). Set to 0 to send immediately.',
    minimum: 0,
    maximum: 10080,
    example: 360,
  })
  /** Delay before the post-appointment feedback request (default 360 = 6h). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10080) // up to 7 days
  feedbackDelayMinutes?: number;

  @ApiPropertyOptional({
    description: 'Default display language for the clinic\'s patient-facing interfaces (BCP 47 language tag).',
    example: 'ar',
    maxLength: 10,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultLanguage?: string;

  @ApiPropertyOptional({
    description: 'Default currency code (ISO 4217) used for billing and invoices.',
    example: 'SAR',
    maxLength: 10,
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiPropertyOptional({
    description:
      'Whether the WhatsApp AI chatbot is enabled for this clinic. When true, incoming WhatsApp messages are routed to the AI booking assistant.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  botEnabled?: boolean;
}
