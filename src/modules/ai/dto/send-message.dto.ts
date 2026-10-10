import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
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
}
