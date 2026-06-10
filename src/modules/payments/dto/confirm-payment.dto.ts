import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Confirm/verify a payment. Usually no body is needed (the gateway payment id
 * is already stored). When the payment was created client-side with the
 * publishable key, pass the resulting `gatewayPaymentId` to link + verify it.
 */
export class ConfirmPaymentDto {
  @ApiPropertyOptional({
    description: 'Gateway payment id to link/verify (client-side created flows).',
    example: 'a1b2c3d4-pay',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  gatewayPaymentId?: string;
}
