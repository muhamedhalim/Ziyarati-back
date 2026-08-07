import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * "Issue not resolved" — an optional reason. `status`/`resolvedAt`/`closedAt`
 * are never accepted from the client; the resolved -> in_progress transition
 * is hardcoded server-side (see SupportTicketService.reopenOwnTicket).
 */
export class ReopenTicketDto {
  @ApiPropertyOptional({
    maxLength: 2000,
    example: 'The calendar is still blank after refreshing.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note?: string;
}
