import {
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Move an appointment to a new time. Persists an `appointment_reschedules`
 * audit row (reason + who) and records the old→new times in the appointment
 * history, then updates `start_at`/`end_at`. The new window is conflict-checked
 * against the staff member's existing appointments.
 */
export class RescheduleAppointmentDto {
  @ApiProperty({
    description: 'New start time (ISO-8601 with offset). Stored as `timestamptz`.',
    example: '2026-06-12T11:00:00+03:00',
  })
  @IsISO8601()
  newStartAt!: string;

  @ApiPropertyOptional({
    description:
      'New end time (ISO-8601). If omitted, the original appointment duration is preserved and applied from `newStartAt`.',
    example: '2026-06-12T11:45:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  newEndAt?: string;

  @ApiPropertyOptional({
    description: 'Reason for the reschedule (stored in the audit trail).',
    example: 'Practitioner unavailable; moved to next available slot.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
