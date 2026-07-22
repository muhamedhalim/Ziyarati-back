import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

/**
 * Register a new outbound webhook endpoint. The signing secret is generated
 * server-side and returned ONCE in the response — never again.
 */
export class CreateWebhookEndpointDto {
  @ApiPropertyOptional({ description: 'Human label for the endpoint.', example: 'Clinic ERP' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: 'The external URL to receive signed POST deliveries. http or https only.',
    example: 'https://erp.myclinic.example/webhooks/ziyarati',
  })
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MaxLength(2048)
  url!: string;

  @ApiProperty({
    description: 'Event types this endpoint subscribes to. Must be from the fixed allowlist.',
    type: [String],
    enum: WEBHOOK_EVENTS,
    example: ['appointment.created', 'appointment.cancelled'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(WEBHOOK_EVENTS.length)
  @IsString({ each: true })
  @IsIn(WEBHOOK_EVENTS, { each: true })
  events!: string[];
}
