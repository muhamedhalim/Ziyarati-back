import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  RECONCILIATION_EXCEPTION_STATUS,
  RECONCILIATION_KIND,
} from '../payments.constants';

/** Filter + pagination for the reconciliation queue (platform-wide, super admin). */
export class QueryReconciliationDto {
  @ApiPropertyOptional({
    enum: Object.values(RECONCILIATION_EXCEPTION_STATUS),
    description: 'Only exceptions in this state.',
  })
  @IsOptional()
  @IsIn(Object.values(RECONCILIATION_EXCEPTION_STATUS))
  status?: string;

  @ApiPropertyOptional({
    enum: Object.values(RECONCILIATION_KIND),
    description: 'Only this kind of discrepancy.',
  })
  @IsOptional()
  @IsIn(Object.values(RECONCILIATION_KIND))
  kind?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this clinic.' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** Close an OPEN exception. */
export class CloseReconciliationDto {
  @ApiProperty({
    enum: ['RESOLVED', 'IGNORED'],
    description:
      'RESOLVED = it was handled (refund issued, record corrected). IGNORED = a decision not to act; a note is required.',
  })
  @IsIn(['RESOLVED', 'IGNORED'])
  status!: 'RESOLVED' | 'IGNORED';

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** A Tap charges-report CSV exported from Tap's dashboard (the fallback when the API cannot be read). */
export class ImportReconciliationReportDto {
  @ApiProperty({
    description:
      'The CSV text of Tap’s charges report (first row = headers incl. charge_id, amount, currency, status). Import one date range at a time.',
  })
  @IsString()
  @MaxLength(2_000_000)
  csv!: string;
}
