import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { SUPPORTED_PAYMENT_CURRENCIES } from '../payments.constants';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  IsIn,
} from 'class-validator';

/**
 * Create a payment for the caller's tenant. Tenant is NEVER taken from here.
 *
 * Financial-authority rule: when `appointmentId` is set, the booking price is
 * read from the DATABASE — `amount`/`currency` here are optional cross-checks
 * and any mismatch is rejected. Without an appointment (staff POS flow), an
 * explicit `amount` is required.
 */
export class CreatePaymentDto {
  @ApiProperty({
    description:
      'Amount in major currency units. Optional (cross-check only) when appointmentId is set — the booking price comes from the server.',
    example: 150.0,
    required: false,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({
    description: 'ISO currency code. Defaults to SAR.',
    example: 'SAR',
    default: 'SAR',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsIn([...SUPPORTED_PAYMENT_CURRENCIES])
  currency?: string;

  @ApiPropertyOptional({
    description: 'Gateway to use. Defaults to tap.',
    example: 'tap',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  gateway?: string;

  @ApiPropertyOptional({ description: 'Customer this payment is for.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Appointment this payment settles.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({ description: 'Branch the payment belongs to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Description shown to the payer.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ description: 'Return URL after a hosted/3DS payment.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  callbackUrl?: string;

  @ApiPropertyOptional({
    description: 'Idempotency key — makes create safe to retry (per tenant).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}
