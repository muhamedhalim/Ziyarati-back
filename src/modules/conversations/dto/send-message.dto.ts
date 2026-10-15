import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  API_SENDABLE_SENDER_TYPES,
  MESSAGE_TYPE,
  MESSAGE_TYPES,
  SENDER_TYPE,
} from '../conversation.constants';

/**
 * Sends a message in a conversation. The sender (when AGENT) is the
 * authenticated user — taken from the principal, never the body. The send is
 * transactional: it creates the message, an initial SENT status log, and bumps
 * the conversation's `last_message_at`.
 */
export class SendMessageDto {
  @ApiPropertyOptional({
    description: 'Message body. Required for `text`/`system`; optional for `image`/`file` (the URL lives on the attachment).',
    example: 'Hello! How can we help you today?',
    maxLength: 8000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  content?: string;

  @ApiPropertyOptional({
    description: 'Message type. Defaults to `text`.',
    enum: MESSAGE_TYPES,
    example: MESSAGE_TYPE.TEXT,
    default: MESSAGE_TYPE.TEXT,
  })
  @IsOptional()
  @IsIn(MESSAGE_TYPES)
  messageType?: string;

  @ApiPropertyOptional({
    description: 'Sender type. Defaults to `AGENT` (the authenticated user). `BOT`/`SYSTEM` allowed for automation. `CUSTOMER` messages arrive via the WhatsApp webhook, not this API.',
    enum: API_SENDABLE_SENDER_TYPES,
    example: SENDER_TYPE.AGENT,
    default: SENDER_TYPE.AGENT,
  })
  @IsOptional()
  @IsIn(API_SENDABLE_SENDER_TYPES)
  senderType?: string;
}
