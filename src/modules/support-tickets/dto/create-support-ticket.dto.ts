import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { TICKET_CATEGORIES, TICKET_PRIORITIES } from '../support-tickets.constants';
import type { TicketCategory, TicketPriority } from '../support-tickets.constants';

/** Tenant-submitted ticket. Status always starts at `open`; never client-supplied. */
export class CreateSupportTicketDto {
  @ApiProperty({ description: 'Short summary of the issue.', maxLength: 200, example: 'Cannot load appointment calendar' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject!: string;

  @ApiProperty({ enum: TICKET_CATEGORIES, description: 'Ticket category.' })
  @IsIn(TICKET_CATEGORIES)
  category!: TicketCategory;

  @ApiProperty({ enum: TICKET_PRIORITIES, description: 'Reported urgency.' })
  @IsIn(TICKET_PRIORITIES)
  priority!: TicketPriority;

  @ApiProperty({ description: 'Full description of the issue.', maxLength: 5000, example: 'The calendar view has been blank since this morning...' })
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  description!: string;

  @ApiPropertyOptional({
    description:
      'Opaque storage key returned by `POST /uploads` (docType "support_ticket"). Ownership + existence are re-verified server-side.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentKey?: string;
}
