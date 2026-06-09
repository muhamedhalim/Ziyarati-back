import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Manually create a webhook log entry (admin/authenticated).
 *
 * Schema note: `whatsapp_webhooks` is an inbound EVENT LOG — it has no URL or
 * secret column. There is no outbound "webhook configuration" to store; these
 * fields map to the event-log columns (`event_type`, `payload`, `processed`,
 * `idempotency_key`).
 */
export class CreateWhatsappWebhookDto {
  @ApiPropertyOptional({ description: 'Event type.', example: 'messages', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eventType?: string;

  @ApiPropertyOptional({
    description: 'Event payload (JSONB).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Idempotency key.', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;

  @ApiPropertyOptional({ description: 'Whether the event is already processed.', example: false, default: false })
  @IsOptional()
  @IsBoolean()
  processed?: boolean;
}
