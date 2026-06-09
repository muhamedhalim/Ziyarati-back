import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Edits a message's content.
 *
 * Schema note: `messages` has no `edited_at`/`is_edited` column, so the edit is
 * not separately audited (the content column is updated in place).
 */
export class UpdateMessageDto {
  @ApiProperty({
    description: 'New message content.',
    example: 'Updated message text.',
    minLength: 1,
    maxLength: 8000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  content!: string;
}
