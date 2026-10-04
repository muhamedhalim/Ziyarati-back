import { Type } from 'class-transformer';
import {
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

import { InvoiceStatus } from '../../../entities/enums';

export const SUBSCRIPTION_INVOICE_SORTABLE = [
  'issued_at',
  'paid_at',
  'amount',
  'status',
] as const;

export const SUBSCRIPTION_INVOICE_KINDS = [
  'INITIAL',
  'UPGRADE',
  'RENEWAL',
  'REACTIVATION',
  // Invoices issued before kinds existed carry no kind.
  'LEGACY',
] as const;

/** Filter / sort / paginate the platform's subscription-revenue ledger (super admin). */
export class QuerySubscriptionInvoicesDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this clinic.' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: Object.values(InvoiceStatus) })
  @IsOptional()
  @IsIn(Object.values(InvoiceStatus))
  status?: string;

  @ApiPropertyOptional({
    enum: SUBSCRIPTION_INVOICE_KINDS,
    description:
      'Why the invoice was issued. LEGACY = issued before kinds existed.',
  })
  @IsOptional()
  @IsIn(SUBSCRIPTION_INVOICE_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({
    description: 'The payment provider that collected it (e.g. tap).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  provider?: string;

  @ApiPropertyOptional({
    enum: ['IN_FLIGHT', 'REFUNDED'],
    description:
      'IN_FLIGHT = a refund was accepted by the provider but is not complete; REFUNDED = refunded.',
  })
  @IsOptional()
  @IsIn(['IN_FLIGHT', 'REFUNDED'])
  refund?: 'IN_FLIGHT' | 'REFUNDED';

  @ApiPropertyOptional({
    enum: ['true'],
    description:
      'Only OPEN invoices a charge has failed on (a retry is scheduled or the clinic must act).',
  })
  @IsOptional()
  @IsIn(['true'])
  attention?: 'true';

  @ApiPropertyOptional({ description: 'Issued on or after (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  issuedFrom?: string;

  @ApiPropertyOptional({ description: 'Issued on or before (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  issuedTo?: string;

  @ApiPropertyOptional({
    description: 'Clinic name, invoice id or provider charge id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({
    enum: SUBSCRIPTION_INVOICE_SORTABLE,
    default: 'issued_at',
  })
  @IsOptional()
  @IsIn(SUBSCRIPTION_INVOICE_SORTABLE as unknown as string[])
  sortBy: (typeof SUBSCRIPTION_INVOICE_SORTABLE)[number] = 'issued_at';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional()
  @IsIn(['ASC', 'DESC'])
  sortDir: 'ASC' | 'DESC' = 'DESC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
