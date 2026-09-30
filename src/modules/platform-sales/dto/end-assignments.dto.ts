import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_BULK_MAX } from '../platform-sales.constants';

export class EndAssignmentsDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: SALES_BULK_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALES_BULK_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assignmentIds!: string[];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Hand-off of an employee's clinics to another employee (typically before
 * deactivating them). Exactly one of `assignmentIds` (a chosen subset) or
 * `all: true` (their whole active portfolio, capped at SALES_BULK_MAX per call).
 */
export class TransferAssignmentsDto {
  @ApiProperty({ description: 'The employee who takes the clinics over.' })
  @IsUUID('all')
  toEmployeeId!: string;

  @ApiPropertyOptional({ type: [String], maxItems: SALES_BULK_MAX })
  @ValidateIf((o: TransferAssignmentsDto) => o.all !== true)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SALES_BULK_MAX)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  assignmentIds?: string[];

  @ApiPropertyOptional({
    description: `Transfer the whole active portfolio (up to ${SALES_BULK_MAX} clinics per call; repeat until none remain).`,
  })
  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
