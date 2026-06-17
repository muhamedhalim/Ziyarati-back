import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Create a (full or partial) refund against an existing payment. */
export class CreateRefundDto {
  @ApiProperty({ description: 'Payment to refund (must belong to the caller tenant).', format: 'uuid' })
  @IsUUID()
  paymentId!: string;

  @ApiPropertyOptional({
    description: 'Amount to refund in major units. Omit for a FULL refund of the remaining balance.',
    example: 50.0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({ description: 'Reason for the refund (audit).' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Idempotency key. Retrying with the same key returns the existing refund instead of issuing a second gateway refund (safe retry). Strongly recommended.',
    maxLength: 128,
    example: 'refund-appt-50-001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}
