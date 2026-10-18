import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

import { SALES_ASSIGNMENT_KIND } from '../../../entities/Sales/SalesClinicAssignment';
import type { SalesAssignmentKind } from '../../../entities/Sales/SalesClinicAssignment';

/**
 * The non-file fields of a clinic-import upload (multipart, so every value
 * arrives as a string). Nothing here can name a tenant, role, plan or amount —
 * `forbidNonWhitelisted` rejects anything else.
 */
export class ClinicImportOptionsDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    default: 'false',
    description:
      'Email each created owner a single-use set-password link. Off by default: owners can always use "forgot password".',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  sendInvitations?: 'true' | 'false';

  @ApiPropertyOptional({
    enum: SALES_ASSIGNMENT_KIND,
    default: 'acquired',
    description:
      'Kind of the assignment for rows that name a `sales_rep_email`. `acquired` credits the rep with bringing the clinic in.',
  })
  @IsOptional()
  @IsIn(SALES_ASSIGNMENT_KIND)
  assignmentKind?: SalesAssignmentKind;
}
