import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * A clinic-visible reply — used on both the clinic side (own ticket) and the
 * platform side (any ticket). Deliberately carries ONLY `note`: `internalOnly`,
 * `type` and `actorRole` are never accepted from the client — visibility,
 * event type and actor are all set server-side (see SupportTicketService).
 */
export class AddTicketReplyDto {
  @ApiProperty({
    maxLength: 2000,
    example: 'Thanks for reporting — we are looking into it now.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note!: string;
}
