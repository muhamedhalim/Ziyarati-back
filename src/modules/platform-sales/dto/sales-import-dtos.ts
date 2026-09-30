import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import { SALES_ASSIGNMENT_KIND } from '../../../entities/Sales/SalesClinicAssignment';
import type { SalesAssignmentKind } from '../../../entities/Sales/SalesClinicAssignment';
import {
  SALES_EXPORT_STATUS,
  SALES_ON_CONFLICT,
} from '../platform-sales.constants';
import type {
  SalesExportStatus,
  SalesOnConflict,
} from '../platform-sales.constants';

/**
 * The non-file fields of an import upload (multipart). The employee comes from
 * the ROUTE, never from the file, so a spreadsheet cannot redirect rows to
 * someone else.
 */
export class ImportAssignmentsDto {
  @ApiPropertyOptional({
    enum: SALES_ON_CONFLICT,
    default: 'skip',
    description:
      'A clinic another employee already owns is reported (`skip`) or taken over (`reassign`, closing that assignment).',
  })
  @IsOptional()
  @IsIn(SALES_ON_CONFLICT)
  onConflict?: SalesOnConflict;

  @ApiPropertyOptional({
    enum: SALES_ASSIGNMENT_KIND,
    default: 'managed',
    description:
      'Kind for rows whose `kind` cell is blank. `acquired` credits the employee with bringing the clinic in (once per clinic, ever).',
  })
  @IsOptional()
  @IsIn(SALES_ASSIGNMENT_KIND)
  defaultKind?: SalesAssignmentKind;
}

export class QueryAssignmentsExportDto {
  @ApiPropertyOptional({ description: 'Limit the export to one sales employee.' })
  @IsOptional()
  @IsUUID('all')
  employeeId?: string;

  @ApiPropertyOptional({ enum: SALES_EXPORT_STATUS, default: 'active' })
  @IsOptional()
  @IsIn(SALES_EXPORT_STATUS)
  status?: SalesExportStatus;
}
