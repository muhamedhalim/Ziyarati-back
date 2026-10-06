import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

/** WhatsApp's own limit for a text message body. */
export const WHATSAPP_TEXT_MAX_LENGTH = 4096;

export class StaffWhatsappReplyDto {
  @ApiProperty({
    description:
      'The reply to send to the patient over WhatsApp. 1–4096 characters.',
    example: 'Hello, your appointment is confirmed for tomorrow at 10:00.',
    maxLength: WHATSAPP_TEXT_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(WHATSAPP_TEXT_MAX_LENGTH)
  content!: string;
}
