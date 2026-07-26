import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { BILLING_UPGRADE_STATUS, BILLING_UPGRADE_TYPE } from '../billing-upgrade.constants';

/** Owner-side list filter (always scoped to the caller's own tenant). */
export class QueryBillingUpgradeRequestsDto {
  @ApiPropertyOptional({ enum: Object.values(BILLING_UPGRADE_STATUS) })
  @IsOptional()
  @IsIn(Object.values(BILLING_UPGRADE_STATUS))
  status?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** Platform-side list filter — cross-tenant, so `tenantId` is a valid filter here. */
export class QueryPlatformBillingUpgradeRequestsDto extends QueryBillingUpgradeRequestsDto {
  @ApiPropertyOptional({ description: 'Filter by tenant.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @ApiPropertyOptional({ enum: Object.values(BILLING_UPGRADE_TYPE) })
  @IsOptional()
  @IsIn(Object.values(BILLING_UPGRADE_TYPE))
  type?: string;
}
