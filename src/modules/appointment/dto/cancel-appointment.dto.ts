import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Cancel an appointment. Persists an `appointment_cancellations` audit row
 * (reason, who, refund) plus a status log + history entry, and sets the
 * appointment status to `CANCELLED`.
 */
export class CancelAppointmentDto {
  @ApiPropertyOptional({
    description: 'Reason for cancellation (stored in the audit trail).',
    example: 'Customer requested cancellation due to travel.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({
    description:
      'Refund amount to record against the cancellation (informational audit value; actual refund processing is handled by the payments domain).',
    example: 150.0,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  refundAmount?: number;
}
