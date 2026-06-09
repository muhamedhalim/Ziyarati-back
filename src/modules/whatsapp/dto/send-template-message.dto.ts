import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Sends (or schedules) a template message. Provide exactly one recipient:
 * `contactId`, `customerId`, or a raw `toWaId`. The send goes through the
 * provider abstraction and is recorded on `notification_logs` (channel WHATSAPP).
 */
export class SendTemplateMessageDto {
  @ApiPropertyOptional({
    description: 'WhatsApp account to send from. If omitted, the tenant\'s active account is used.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiPropertyOptional({ description: 'Recipient WhatsApp contact id (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  contactId?: string;

  @ApiPropertyOptional({ description: 'Recipient customer id (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Raw destination WhatsApp id / phone (E.164 digits). Used when no contact/customer is given.',
    example: '966501234567',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  toWaId?: string;

  @ApiPropertyOptional({
    description: 'Template variable substitutions, e.g. `{ "1": "Sara", "2": "10:00" }`.',
    type: 'object',
    additionalProperties: true,
    example: { '1': 'Sara', '2': '2026-06-15 10:00' },
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'For the schedule endpoint: when to send (ISO-8601). Ignored by the immediate send endpoint.',
    example: '2026-06-15T08:00:00+03:00',
  })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({
    description: 'Optional idempotency key to de-duplicate retries.',
    example: 'appt-50-reminder-24h',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  idempotencyKey?: string;
}
