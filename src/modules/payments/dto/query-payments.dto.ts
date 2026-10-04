import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PaymentStatus, SettlementStatus } from '../../../entities/enums';
import { PAYMENT_PURPOSE, type PaymentPurpose } from '../payments.constants';

/** Filter + pagination for payments (always tenant-scoped). */
export class QueryPaymentsDto {
  @ApiPropertyOptional({ description: 'Filter by payment status.', enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ description: 'Filter by settlement status.', enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  settlementStatus?: SettlementStatus;

  @ApiPropertyOptional({
    description:
      "Filter by what the payment is for. When omitted the list shows only the clinic's own money (BOOKING and MANUAL); the clinic's add-on and billing-upgrade payments to the platform are returned only when asked for by name.",
    enum: Object.values(PAYMENT_PURPOSE),
  })
  @IsOptional()
  @IsIn(Object.values(PAYMENT_PURPOSE))
  purpose?: PaymentPurpose;

  @ApiPropertyOptional({
    enum: ['PROVISIONAL', 'RECONCILED'],
    description:
      'Fee status of captured money. PROVISIONAL = the payment provider has not reported its fee yet, so the net amount is an estimate; RECONCILED = the fee was written from the provider report.',
  })
  @IsOptional()
  @IsIn(['PROVISIONAL', 'RECONCILED'])
  feeStatus?: 'PROVISIONAL' | 'RECONCILED';

  @ApiPropertyOptional({
    description:
      'Find a payment by the provider charge id (e.g. chg_…) or by the start of its payment id.',
    maxLength: 80,
  })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;

  @ApiPropertyOptional({ description: 'Only payments for this customer.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on created_at. ISO-8601.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
