import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * General appointment update — reassign staff/branch and edit notes.
 *
 * Date/time changes are intentionally NOT here: use `POST /appointments/:id/reschedule`
 * (creates an auditable reschedule record). Service changes use
 * `PUT /appointments/:id/services` (recomputes totals + duration).
 *
 * Tenant scoping: tenant comes from the principal; any new staff/branch is
 * validated to belong to the same tenant.
 */
export class UpdateAppointmentDto {
  @ApiPropertyOptional({
    description: 'Reassign the appointment to a different staff member. Conflict-checked against the new staff member\'s schedule.',
    example: 'c1d2e3f4-0000-0000-0000-000000000031',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description: 'Move the appointment to a different branch of the same clinic.',
    example: 'c1d2e3f4-0000-0000-0000-000000000011',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Replace the free-text notes on the appointment.',
    example: 'Customer called to confirm attendance.',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
