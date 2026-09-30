import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_ASSIGNMENT_KIND } from '../../../entities/Sales/SalesClinicAssignment';
import type { SalesAssignmentKind } from '../../../entities/Sales/SalesClinicAssignment';
import { SALES_BULK_MAX, SALES_ON_CONFLICT } from '../platform-sales.constants';
import type { SalesOnConflict } from '../platform-sales.constants';

/**
 * Hands clinics to ONE sales employee (the one in the route). `tenantIds` are
 * the OBJECTS being assigned — the platform scope itself comes from the
 * authenticated principal — and every id is verified against the database.
 */
export class AssignClinicsDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: SALES_BULK_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALES_BULK_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  tenantIds!: string[];

  @ApiPropertyOptional({
    enum: SALES_ASSIGNMENT_KIND,
    default: 'managed',
    description:
      '`acquired` credits the employee with bringing the clinic in (counts toward the new-clinics target, granted once per clinic ever). `managed` is a portfolio assignment.',
  })
  @IsOptional()
  @IsIn(SALES_ASSIGNMENT_KIND)
  kind?: SalesAssignmentKind;

  @ApiPropertyOptional({
    enum: SALES_ON_CONFLICT,
    default: 'skip',
    description:
      'A clinic another employee already owns is skipped, or (`reassign`) taken over — closing that assignment.',
  })
  @IsOptional()
  @IsIn(SALES_ON_CONFLICT)
  onConflict?: SalesOnConflict;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
