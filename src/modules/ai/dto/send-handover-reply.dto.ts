import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** A human agent's reply while the conversation is HANDED_OVER. */
export class SendHandoverReplyDto {
  @ApiProperty({ description: 'Reply content sent to the customer.', maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  content!: string;
}
