import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

import { TICKET_PRIORITIES } from '../support-tickets.constants';
import type { TicketPriority } from '../support-tickets.constants';

export class UpdateTicketPriorityDto {
  @ApiProperty({ enum: TICKET_PRIORITIES })
  @IsIn(TICKET_PRIORITIES)
  priority!: TicketPriority;
}
