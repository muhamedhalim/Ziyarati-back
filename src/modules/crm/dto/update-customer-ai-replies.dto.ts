import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateCustomerAiRepliesDto {
  @ApiProperty({
    description:
      'true = exclude this patient from the WhatsApp AI (their messages are still received and shown to staff); false = allow the AI again.',
    example: true,
  })
  @IsBoolean()
  disabled!: boolean;
}
