import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '../../../entities/enums';

/**
 * Filter + pagination for listing appointments. All filters are optional and
 * are applied ON TOP OF the mandatory tenant scope (never replacing it).
 */
export class QueryAppointmentsDto {
  @ApiPropertyOptional({
    description: 'Filter by appointment status.',
    enum: AppointmentStatus,
    example: AppointmentStatus.CONFIRMED,
  })
  @IsOptional()
  @IsEnum(AppointmentStatus)
  status?: AppointmentStatus;

  @ApiPropertyOptional({
    description: 'Filter to a specific branch.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filter to a specific staff member.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000030',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description: 'Filter to a specific customer.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000020',
  })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Lower bound (inclusive) on `start_at`. ISO-8601.',
    example: '2026-06-01T00:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    description: 'Upper bound (exclusive) on `start_at`. ISO-8601.',
    example: '2026-07-01T00:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    description: 'Page number (1-based).',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Results per page. Maximum 100.',
    example: 20,
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
