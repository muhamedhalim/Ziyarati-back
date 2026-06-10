import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Generate a settlement batch: aggregate the tenant's UNSETTLED, PAID payments
 * (optionally within a period / branch) into one Settlement with mapped items.
 */
export class GenerateSettlementDto {
  @ApiPropertyOptional({ description: 'Period start (inclusive). ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @ApiPropertyOptional({ description: 'Period end (exclusive). ISO-8601.', example: '2026-07-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Platform fee percent applied to the gross (0–100). Defaults to 0.',
    example: 2.5,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  feePercent?: number;

  @ApiPropertyOptional({ description: 'Settlement currency. Defaults to SAR.', example: 'SAR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
