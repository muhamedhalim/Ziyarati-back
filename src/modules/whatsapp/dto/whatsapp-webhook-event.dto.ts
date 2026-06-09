import {
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Inbound WhatsApp webhook event payload (public ingestion endpoint). The tenant
 * is resolved server-side from the payload (phone_number_id → account), never
 * trusted from the body.
 */
export class WhatsappWebhookEventDto {
  @ApiPropertyOptional({
    description: 'Event type, e.g. `messages`, `message_status`, `template_status_update`.',
    example: 'message_status',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiProperty({
    description: 'Raw provider webhook payload (stored as JSONB).',
    type: 'object',
    additionalProperties: true,
    example: { object: 'whatsapp_business_account', entry: [] },
  })
  @IsObject()
  payload!: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Idempotency key to de-duplicate redelivered events.',
    example: 'wamid.HBgN...',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
