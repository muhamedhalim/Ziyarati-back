import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
} from 'class-validator';

/** Generate a shareable payment link for the caller's tenant. */
export class CreatePaymentLinkDto {
  @ApiProperty({ description: 'Amount in major currency units.', example: 200.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @ApiPropertyOptional({ description: 'Appointment the link is for.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @ApiPropertyOptional({
    description: 'Expiry timestamp (ISO-8601). Defaults to 72h from creation.',
    example: '2026-07-01T00:00:00Z',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}
