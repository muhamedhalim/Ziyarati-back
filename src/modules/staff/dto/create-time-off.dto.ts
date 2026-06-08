import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Records a block of time off for a staff member (vacation / sick leave /
 * manual admin entry).
 *
 * ⚠️ Schema note: the finalized `staff_time_off` table has only
 * `start_date / end_date / reason` — it has NO `status` or `approved_by`
 * columns. Per the "do not change the schema" constraint, a persisted row is
 * therefore treated as an EFFECTIVE (approved) absence; a pending→approved
 * workflow would require a migration and is intentionally out of scope here.
 */
export class CreateTimeOffDto {
  @ApiProperty({
    description: 'First day of the absence (inclusive). `YYYY-MM-DD`.',
    example: '2026-07-01',
    format: 'date',
  })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    description: 'Last day of the absence (inclusive). `YYYY-MM-DD`. Must be ≥ startDate.',
    example: '2026-07-10',
    format: 'date',
  })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({
    description: 'Reason / type of leave (e.g. "Annual vacation", "Sick leave").',
    example: 'Annual vacation',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
