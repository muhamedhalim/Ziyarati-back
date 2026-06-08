import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '../../../entities/enums';

/**
 * Drive the appointment through its lifecycle. Only transitions allowed by the
 * status state-machine are accepted (see AppointmentsService).
 *
 * NOTE: `CANCELLED` is NOT accepted here — cancellation is a first-class action
 * (`POST /appointments/:id/cancel`) that captures a reason, actor and refund.
 */
export class ChangeAppointmentStatusDto {
  @ApiProperty({
    description:
      'Target status. Allowed targets via this endpoint: `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, `NO_SHOW`. Use the cancel endpoint for `CANCELLED`.',
    enum: [
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.IN_PROGRESS,
      AppointmentStatus.COMPLETED,
      AppointmentStatus.NO_SHOW,
    ],
    example: AppointmentStatus.CONFIRMED,
  })
  @IsEnum(AppointmentStatus)
  status!: AppointmentStatus;

  @ApiPropertyOptional({
    description: 'Optional note recorded in the appointment history alongside the status change.',
    example: 'Confirmed by phone with the patient.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
