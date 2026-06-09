import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  API_SENDABLE_SENDER_TYPES,
  MESSAGE_TYPE,
  MESSAGE_TYPES,
  SENDER_TYPE,
} from '../conversation.constants';

/**
 * Sends the same message to MULTIPLE conversations (broadcast). Each
 * conversation is validated to belong to the caller's tenant; per-conversation
 * results are returned so partial failures are visible.
 */
export class BulkMessageDto {
  @ApiProperty({
    description: 'Target conversation ids (tenant-scoped). Max 500 per request.',
    type: [String],
    format: 'uuid',
    example: ['c1d2e3f4-0000-0000-0000-000000000001'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  conversationIds!: string[];

  @ApiProperty({ description: 'Message content.', example: 'Clinic will be closed on the public holiday.', maxLength: 8000 })
  @IsString()
  @MaxLength(8000)
  content!: string;

  @ApiPropertyOptional({ description: 'Message type. Defaults to `text`.', enum: MESSAGE_TYPES, default: MESSAGE_TYPE.TEXT })
  @IsOptional()
  @IsIn(MESSAGE_TYPES)
  messageType?: string;

  @ApiPropertyOptional({ description: 'Sender type. Defaults to `AGENT`.', enum: API_SENDABLE_SENDER_TYPES, default: SENDER_TYPE.AGENT })
  @IsOptional()
  @IsIn(API_SENDABLE_SENDER_TYPES)
  senderType?: string;
}
