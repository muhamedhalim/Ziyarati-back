import {
  ArrayUnique,
  IsArray,
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

/** The only supported reminder lead times, in minutes: 1 day, 3 hours, 1 hour. */
export const SUPPORTED_REMINDER_LEAD_MINUTES = [1440, 180, 60] as const;

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

  @ApiPropertyOptional({
    description:
      'How many minutes the WhatsApp AI stays silent on a conversation after a staff member replies to it (automatic human takeover). 0 — the default — turns automatic takeover off. Maximum 1440 (24 hours).',
    minimum: 0,
    maximum: 1440,
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  aiHumanTakeoverMinutes?: number;

  @ApiPropertyOptional({
    description:
      'Whether a staff member must have a configured working window (staff schedule ∩ branch working hours, or a calendar slot) before they can be booked at a given time. When false (the default), a staff member with nothing configured for that day has no working-hours constraint — holidays, time off, blocked periods and double-booking are still enforced. Turn this on once the clinic maintains its schedules.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  enforceStaffWorkingHours?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether this clinic is listed by the PUBLIC (anonymous) booking assistant on the platform website. ' +
      'When false — the default — the clinic is invisible to `list_cities`, `search_clinics` and every public booking tool, ' +
      'and no anonymous visitor can book with it. Turn it on once branches, services and staff schedules are configured.\n\n' +
      "This flag is the ONLY database proof of public bookability the chatbot accepts. A clinic's Knowledge base may describe " +
      'its address, hours and services, but it can never make the clinic bookable — that decision lives here and nowhere else.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  publicBookingEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether a patient can cancel their own appointment from their private action link, with no sign-in. When false — the default — self-service cancellation is unavailable and the clinic cancellation window (cancellationHours) has no self-service path to enforce.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  selfCancellationEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether a patient can reschedule their own appointment from their private action link, with no sign-in. When false — the default — self-service rescheduling is unavailable.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  selfRescheduleEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Whether automated appointment reminders are sent to patients. When false — the default — no reminder is ever scheduled, regardless of reminderLeadMinutes.',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  remindersEnabled?: boolean;

  @ApiPropertyOptional({
    description:
      'How many minutes before an appointment to send a reminder. Only the fixed supported set is accepted: 1440 (1 day), 180 (3 hours), 60 (1 hour) — free-form offsets are rejected.',
    example: [1440, 60],
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn(SUPPORTED_REMINDER_LEAD_MINUTES, { each: true })
  reminderLeadMinutes?: number[];
}
