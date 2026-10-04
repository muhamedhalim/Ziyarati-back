import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Refund a PAID subscription invoice, in full (platform-only). */
export class RefundInvoiceDto {
  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Why the platform is refunding this invoice (audit).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
