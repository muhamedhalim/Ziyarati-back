import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  CONVERSATION_STATUSES,
  CONVERSATION_TYPES,
} from '../conversation.constants';

/** Filter + pagination for listing conversations (always tenant-scoped). */
export class ConversationFilterDto {
  @ApiPropertyOptional({ description: 'Filter by status.', enum: CONVERSATION_STATUSES })
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: string;

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
