import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  SUPPORT_DIAGNOSTIC_DEFAULT_DAYS,
  SUPPORT_DIAGNOSTIC_MAX_DAYS,
  SUPPORT_DIAGNOSTIC_MAX_PAGE_SIZE,
  SUPPORT_DIAGNOSTIC_PAGE_SIZE,
} from '../platform-support.constants';

/**
 * Shared pagination + look-back window for every Support diagnostic history.
 *
 * Both bounds are MANDATORY in effect (they carry defaults and hard ceilings)
 * rather than optional conveniences. A diagnostic view answers "what happened
 * to this clinic recently" — an unbounded scan of `email_logs`, `audit_logs`,
 * `payments` or `ai_execution_metrics` for a busy clinic is simultaneously a
 * performance hazard and more disclosure than any support case needs.
 */
export class QuerySupportDiagnosticsDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: SUPPORT_DIAGNOSTIC_PAGE_SIZE,
    minimum: 1,
    maximum: SUPPORT_DIAGNOSTIC_MAX_PAGE_SIZE,
    default: SUPPORT_DIAGNOSTIC_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUPPORT_DIAGNOSTIC_MAX_PAGE_SIZE)
  limit: number = SUPPORT_DIAGNOSTIC_PAGE_SIZE;

  @ApiPropertyOptional({
    description: 'Look-back window in days.',
    example: SUPPORT_DIAGNOSTIC_DEFAULT_DAYS,
    minimum: 1,
    maximum: SUPPORT_DIAGNOSTIC_MAX_DAYS,
    default: SUPPORT_DIAGNOSTIC_DEFAULT_DAYS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUPPORT_DIAGNOSTIC_MAX_DAYS)
  days: number = SUPPORT_DIAGNOSTIC_DEFAULT_DAYS;

  /** Convenience for the services — the resolved lower bound of the window. */
  since(): Date {
    return new Date(Date.now() - this.days * 86_400_000);
  }

  offset(): number {
    return (this.page - 1) * this.limit;
  }
}

/** Delivery histories additionally filter by status and recipient. */
export class QuerySupportDeliveryDto extends QuerySupportDiagnosticsDto {
  @ApiPropertyOptional({
    description:
      'Filter by delivery status (QUEUED / SENT / FAILED for email; PENDING / SCHEDULED / ' +
      'PROCESSING / SENT / DELIVERED / FAILED / CANCELLED / SEND_UNCERTAIN for notifications).',
    example: 'FAILED',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({
    description:
      'Partial match on the recipient address. Matched server-side against the stored value; ' +
      'the RESPONSE still returns the masked form.',
    example: 'gmail.com',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  recipient?: string;
}
