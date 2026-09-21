import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AI_MESSAGE_MAX_CHARS } from '../ai.constants';

/**
 * Sends a user message into an AI conversation and triggers the RAG execution
 * pipeline (retrieve → assemble → provider → persist + meter).
 */
export class SendMessageDto {
  @ApiProperty({
    description: 'User message content.',
    example: 'What are your opening hours on Friday?',
    minLength: 1,
    maxLength: AI_MESSAGE_MAX_CHARS,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(AI_MESSAGE_MAX_CHARS)
  content!: string;

  @ApiPropertyOptional({ description: 'Stable client retry key; reuse it only for the same logical turn.', maxLength: 120 })
  @IsOptional() @IsString() @MinLength(8) @MaxLength(120)
  idempotencyKey?: string;

  /**
   * Ids returned by `POST /public/guest/attachments`, claimed by this turn.
   *
   * Opaque and safe to accept from a client: the staging key they resolve
   * against is derived from the CALLER's own subject, so quoting another
   * visitor's id resolves to a key that does not exist. Redemption is
   * single-use, so an id captured from a previous turn cannot be replayed
   * either. Everything the model eventually sees — the filename, the text —
   * is produced server-side at upload; the client contributes only the id.
   */
  @ApiPropertyOptional({
    description:
      'Ids of files previously uploaded via POST /public/guest/attachments to attach to this message. Single-use; scoped to the caller.',
    type: [String],
    maxItems: 3,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];
}
