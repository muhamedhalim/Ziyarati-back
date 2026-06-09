import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Sends a user message into an AI conversation and triggers the RAG execution
 * pipeline (retrieve → assemble → provider → persist + meter).
 */
export class SendMessageDto {
  @ApiProperty({
    description: 'User message content.',
    example: 'What are your opening hours on Friday?',
    minLength: 1,
    maxLength: 8000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;
}
