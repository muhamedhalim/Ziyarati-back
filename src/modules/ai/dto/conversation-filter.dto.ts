import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AI_CONVERSATION_STATUSES } from '../ai.constants';

/** Filter + pagination for AI conversations (always tenant-scoped). */
export class ConversationFilterDto {
  @ApiPropertyOptional({ description: 'Filter by status.', enum: AI_CONVERSATION_STATUSES })
  @IsOptional()
  @IsIn(AI_CONVERSATION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by agent.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

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
