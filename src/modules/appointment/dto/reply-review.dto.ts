import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Staff reply to a customer review (public-facing response).
 */
export class ReplyReviewDto {
  @ApiProperty({
    description: 'The clinic\'s reply to the customer\'s review.',
    example: 'Thank you for your kind words — we look forward to seeing you again!',
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  reply!: string;
}
