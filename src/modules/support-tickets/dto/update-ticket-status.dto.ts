import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { TICKET_STATUSES } from '../support-tickets.constants';
import type { TicketStatus } from '../support-tickets.constants';

/** Super-admin status transition (covers Resolve/Reopen — both are just a status). */
export class UpdateTicketStatusDto {
  @ApiProperty({ enum: TICKET_STATUSES })
  @IsIn(TICKET_STATUSES)
  status!: TicketStatus;

  @ApiPropertyOptional({ description: 'Optional context for the change, recorded in the event log.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
