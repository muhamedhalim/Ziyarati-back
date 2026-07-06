import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  CONVERSATION_STATUSES,
  CONVERSATION_TYPES,
} from '../conversation.constants';

/** Agent Inbox tabs (Live Agent Handover). Each maps to a derived WHERE clause
 *  over `owner_type`/`assigned_to`/`status`/`transfer_count` — see ConversationService.findAll. */
export const INBOX_TABS = ['waiting', 'assigned', 'mine', 'closed', 'transferred', 'all'] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

export const INBOX_SORTS = ['newest', 'oldest', 'priority'] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

/** Filter + pagination for listing conversations (always tenant-scoped). */
export class ConversationFilterDto {
  @ApiPropertyOptional({ description: 'Filter by status.', enum: CONVERSATION_STATUSES })
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Agent Inbox tab.', enum: INBOX_TABS })
  @IsOptional()
  @IsIn(INBOX_TABS)
  inboxTab?: InboxTab;

  @ApiPropertyOptional({ description: 'Free-text search over customer name/phone/email.', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'Only conversations unread by the current agent.' })
  @IsOptional()
  @Type(() => Boolean)
  unreadOnly?: boolean;

  @ApiPropertyOptional({ description: 'Sort order.', enum: INBOX_SORTS, default: 'newest' })
  @IsOptional()
  @IsIn(INBOX_SORTS)
  sort?: InboxSort;

  @ApiPropertyOptional({ description: 'Filter by type.', enum: CONVERSATION_TYPES })
  @IsOptional()
  @IsIn(CONVERSATION_TYPES)
  type?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned agent.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional({ description: 'Filter by customer.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'Filter by branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filter to conversations a specific user participates in (participant join).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  participantUserId?: string;

  @ApiPropertyOptional({ description: 'Lower bound (inclusive) on `created_at`. ISO-8601.', example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound (exclusive) on `created_at`. ISO-8601.', example: '2026-07-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
