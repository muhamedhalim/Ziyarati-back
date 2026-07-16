import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import {
  DEFAULT_TICKET_SORT_FIELD,
  DEFAULT_TICKET_SORT_ORDER,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_SORTABLE_FIELDS,
  TICKET_STATUSES,
} from '../support-tickets.constants';
import type {
  TicketCategory,
  TicketPriority,
  TicketSortField,
  TicketStatus,
} from '../support-tickets.constants';

/** Filter + sort + pagination for the tenant's own ticket list (always tenant-scoped). */
export class QueryMyTicketsDto {
  @ApiPropertyOptional({ description: 'Partial match on subject or ticket number.', example: 'calendar' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TICKET_CATEGORIES })
  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: TicketCategory;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @ApiPropertyOptional({ enum: TICKET_SORTABLE_FIELDS, default: DEFAULT_TICKET_SORT_FIELD })
  @IsOptional()
  @IsIn(TICKET_SORTABLE_FIELDS)
  sortBy: TicketSortField = DEFAULT_TICKET_SORT_FIELD;

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], default: DEFAULT_TICKET_SORT_ORDER })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(['ASC', 'DESC'])
  sortOrder: 'ASC' | 'DESC' = DEFAULT_TICKET_SORT_ORDER;

  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
