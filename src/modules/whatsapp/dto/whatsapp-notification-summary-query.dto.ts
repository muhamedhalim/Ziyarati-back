import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  ANALYTICS_RANGES,
  DEFAULT_ANALYTICS_RANGE,
} from '../whatsapp-notification-analytics.calc';
import type { AnalyticsRange } from '../whatsapp-notification-analytics.calc';

/**
 * Period selector for the notifications analytics summary. A closed set — not a
 * free date range — so the comparison window is always exactly the same length
 * as the selected one and the query is always bounded.
 */
export class WhatsappNotificationSummaryQueryDto {
  @ApiPropertyOptional({
    enum: ANALYTICS_RANGES,
    default: DEFAULT_ANALYTICS_RANGE,
    description:
      'Trailing window ending now. The comparison period is the equal-length window immediately before it.',
  })
  @IsOptional()
  @IsIn(ANALYTICS_RANGES as unknown as string[])
  range?: AnalyticsRange;
}
