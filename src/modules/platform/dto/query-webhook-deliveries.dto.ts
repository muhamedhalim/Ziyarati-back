import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { WEBHOOK_DELIVERY_STATUS } from '../webhook.constants';

const STATUS_VALUES = Object.values(WEBHOOK_DELIVERY_STATUS);

/** Filter + pagination for webhook delivery history (always tenant-scoped). */
export class QueryWebhookDeliveriesDto {
  @ApiPropertyOptional({ description: 'Filter by webhook endpoint id.' })
  @IsOptional()
  @IsUUID()
  webhookEndpointId?: string;

  @ApiPropertyOptional({ description: 'Filter by delivery status.', enum: STATUS_VALUES })
  @IsOptional()
  @IsIn(STATUS_VALUES)
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
