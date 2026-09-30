import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { SALES_BONUS_STATUS } from '../../../entities/Sales/SalesBonusRecord';
import type { SalesBonusStatus } from '../../../entities/Sales/SalesBonusRecord';
import { SALES_REASON_MAX } from '../platform-sales.constants';
import { SalesPageQueryDto } from './sales-page-query.dto';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Body of `POST .../targets/:period/:metric/bonus/approve`.
 *
 * There is deliberately NO amount here: the server recomputes the bonus from
 * the target's rule and the month's real progress. The only thing the caller
 * may send is the target version it was looking at, so a rule edited in the
 * meantime is a 409 rather than an approval of something the admin did not see.
 * (`forbidNonWhitelisted` rejects any other field, an amount included.)
 */
export class ApproveSalesBonusDto {
  @ApiPropertyOptional({
    description: 'The target `version` the caller last saw. A mismatch is a 409.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** Body of `POST .../bonuses/:bonusId/void`. The reason is enforced (422) by the service. */
export class VoidSalesBonusDto {
  @ApiPropertyOptional({ maxLength: SALES_REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SALES_REASON_MAX)
  reason?: string;
}

/** `GET .../bonus-preview` — one month; defaults to the current one. */
export class QueryBonusPreviewDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @Matches(MONTH, { message: 'period must be a month in the form YYYY-MM' })
  period?: string;
}

/** `GET .../bonuses` — the employee's bonus records, newest month first. */
export class QuerySalesBonusesDto extends SalesPageQueryDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @Matches(MONTH, { message: 'period must be a month in the form YYYY-MM' })
  period?: string;

  @ApiPropertyOptional({ enum: SALES_BONUS_STATUS })
  @IsOptional()
  @IsIn(SALES_BONUS_STATUS)
  status?: SalesBonusStatus;
}
