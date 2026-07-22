import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { WEBHOOK_EVENTS } from '../webhook.constants';

/** Update a webhook endpoint's name and/or subscribed events (URL is immutable — delete + recreate to change it). */
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ description: 'Human label for the endpoint.', example: 'Clinic ERP' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Replace the full set of subscribed event types.',
    type: [String],
    enum: WEBHOOK_EVENTS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENTS.length)
  @IsString({ each: true })
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events?: string[];
}
