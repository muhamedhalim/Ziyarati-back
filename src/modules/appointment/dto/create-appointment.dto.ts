import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentSource } from '../../../entities/enums';

/**
 * Payload for booking a new appointment.
 *
 * Tenant scoping: there is intentionally NO tenantId field. The tenant is taken
 * from the authenticated principal (TenantContext). All referenced resources
 * (branch, customer, staff, services) are validated to belong to that tenant.
 */
export class CreateAppointmentDto {
  @ApiProperty({
    description: 'Branch (location) the appointment takes place at. Must belong to the caller\'s clinic.',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
    format: 'uuid',
  })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    description: 'Customer being booked. Must belong to the caller\'s clinic.',
    example: 'c1d2e3f4-0000-0000-0000-000000000020',
    format: 'uuid',
  })
  @IsUUID()
  customerId!: string;

  @ApiProperty({
    description: 'Staff member who will deliver the service. Must belong to the caller\'s clinic and be available for booking.',
    example: 'c1d2e3f4-0000-0000-0000-000000000030',
    format: 'uuid',
  })
  @IsUUID()
  staffId!: string;

  @ApiProperty({
    description:
      'Appointment start time in ISO-8601 with timezone offset (e.g. `2026-06-10T09:00:00+03:00`). Stored as `timestamptz`.',
    example: '2026-06-10T09:00:00+03:00',
  })
  @IsISO8601()
  startAt!: string;

  @ApiPropertyOptional({
    description:
      'Optional explicit end time (ISO-8601). If omitted, it is computed automatically as `startAt + sum(service durations)`. Required only when no services are attached.',
    example: '2026-06-10T09:45:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  endAt?: string;

  @ApiPropertyOptional({
    description:
      'Services to attach to the appointment. Each must belong to the caller\'s clinic and be active. Their durations determine `endAt` and their prices determine `totalAmount` (snapshotted at booking time).',
    example: [
      'c1d2e3f4-0000-0000-0000-000000000040',
      'c1d2e3f4-0000-0000-0000-000000000041',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  serviceIds?: string[];

  @ApiPropertyOptional({
    description:
      'Booking channel. Defaults to `MANUAL` for API-created bookings. The WhatsApp AI bot uses `WHATSAPP_BOT`.',
    enum: AppointmentSource,
    example: AppointmentSource.MANUAL,
  })
  @IsOptional()
  @IsEnum(AppointmentSource)
  source?: AppointmentSource;

  @ApiPropertyOptional({
    description: 'ISO-4217 currency code for the appointment total. Defaults to `USD`.',
    example: 'SAR',
    minLength: 3,
    maxLength: 3,
  })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    description: 'Free-text booking notes visible on the appointment record.',
    example: 'Patient prefers a female practitioner.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
