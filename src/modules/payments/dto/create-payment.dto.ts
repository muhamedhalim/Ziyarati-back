import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Create a payment for the caller's tenant. Tenant is NEVER taken from here. */
export class CreatePaymentDto {
  @ApiProperty({ description: 'Amount in major currency units.', example: 150.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({
    description: 'ISO currency code. Defaults to SAR (Moyasar).',
    example: 'SAR',
    default: 'SAR',
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({
    description: 'Gateway to use. Defaults to moyasar.',
    example: 'moyasar',
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
