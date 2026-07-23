import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

import { WEBHOOK_EVENTS } from '../webhook.constants';

/** Update a webhook endpoint's URL, name, and/or subscribed events. A URL change is re-validated by the same SSRF guard used at creation. */
export class UpdateWebhookEndpointDto {
  @ApiPropertyOptional({ description: 'Human label for the endpoint.', example: 'Clinic ERP' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Replace the delivery URL. Re-validated by the same SSRF guard as create (http/https only, no internal/private targets).',
    example: 'https://erp.myclinic.example/webhooks/ziyarati',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(2048)
  url?: string;

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
