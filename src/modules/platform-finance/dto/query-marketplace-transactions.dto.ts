import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { PAYMENT_PURPOSE } from '../../payments/payments.constants';

export const TXN_SORTABLE = [
  'created_at',
  'paid_at',
  'amount',
  'net_amount',
  'gateway_fee',
  'platform_fee',
  'status',
] as const;
export type TxnSortBy = (typeof TXN_SORTABLE)[number];

/** A payment purpose, or one of the two groups the finance screens switch between. */
export const TXN_PURPOSE_FILTERS = [
  ...Object.values(PAYMENT_PURPOSE),
  'CLINIC_MONEY',
  'PLATFORM_REVENUE',
] as const;
export type TxnPurposeFilter = (typeof TXN_PURPOSE_FILTERS)[number];

/**
 * Server-side filtering / sorting / pagination for the marketplace
 * transactions admin view. All fields optional; unknown combinations simply
 * narrow the result. Money ranges are passed as numeric strings to avoid float
 * coercion surprises and are parsed in the service.
 */
export class QueryMarketplaceTransactionsDto {
  // ── Entity filters ──────────────────────────────────────────────────────
  @ApiPropertyOptional({ format: 'uuid', description: 'Clinic (tenant) id.' })
  @IsOptional() @IsUUID() tenantId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional() @IsUUID() branchId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Patient (customer) id.' })
  @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Booking (appointment) id.' })
  @IsOptional() @IsUUID() appointmentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Service id (matches any service on the booking).' })
  @IsOptional() @IsUUID() serviceId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Transaction (payment) id.' })
  @IsOptional() @IsUUID() transactionId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Settlement batch id.' })
  @IsOptional() @IsUUID() settlementId?: string;

  @ApiPropertyOptional({ description: 'Gateway payment id (exact).' })
  @IsOptional() @IsString() gatewayPaymentId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() merchantId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() subMerchantId?: string;

  // ── Categorical filters ─────────────────────────────────────────────────
  @ApiPropertyOptional() @IsOptional() @IsString() gateway?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() paymentMethod?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() currency?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() status?: string;
  @ApiPropertyOptional({ description: 'Split/settlement status (UNSETTLED/IN_BATCH/SETTLED).' })
  @IsOptional() @IsString() settlementStatus?: string;
  @ApiPropertyOptional({ description: 'Payout status from the settlement batch.' })
  @IsOptional() @IsString() payoutStatus?: string;
  @ApiPropertyOptional({ description: 'Refund status (NONE/PARTIAL/FULL).' })
  @IsOptional() @IsString() refundStatus?: string;

  @ApiPropertyOptional({
    enum: TXN_PURPOSE_FILTERS,
    description:
      'What the payment is for. A single purpose, or a group: CLINIC_MONEY (BOOKING + MANUAL — what patients paid clinics) or PLATFORM_REVENUE (ADDON + BILLING_UPGRADE — what clinics paid the platform). Omitted = every purpose.',
  })
  @IsOptional() @IsIn(TXN_PURPOSE_FILTERS as unknown as string[]) purpose?: string;

  @ApiPropertyOptional({
    enum: ['PROVISIONAL', 'RECONCILED'],
    description:
      'Fee status of captured money: PROVISIONAL = the provider fee has not been reported yet, RECONCILED = it was written from the provider report.',
  })
  @IsOptional() @IsIn(['PROVISIONAL', 'RECONCILED']) feeStatus?: 'PROVISIONAL' | 'RECONCILED';

  @ApiPropertyOptional({
    enum: ['true'],
    description: 'Only payments that have an OPEN reconciliation exception.',
  })
  @IsOptional() @IsIn(['true']) hasOpenException?: 'true';

  // ── Date ranges (ISO) ───────────────────────────────────────────────────
  @ApiPropertyOptional() @IsOptional() @IsString() createdFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() createdTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() paidFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() paidTo?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() settlementFrom?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() settlementTo?: string;

  // ── Amount ranges ───────────────────────────────────────────────────────
  @ApiPropertyOptional() @IsOptional() @IsNumberString() grossMin?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() grossMax?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() netMin?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() netMax?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() gatewayFeeMin?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() gatewayFeeMax?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() platformFeeMin?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumberString() platformFeeMax?: string;

  // ── Global search ───────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Search clinic, branch, patient, booking/transaction id, gateway/merchant id.' })
  @IsOptional() @IsString() search?: string;

  // ── Sorting + pagination ────────────────────────────────────────────────
  @ApiPropertyOptional({ enum: TXN_SORTABLE, default: 'created_at' })
  @IsOptional() @IsIn(TXN_SORTABLE as unknown as string[]) sortBy: TxnSortBy = 'created_at';

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: 'DESC' })
  @IsOptional() @IsIn(['ASC', 'DESC']) sortDir: 'ASC' | 'DESC' = 'DESC';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
}
