import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  CONVERSATION_STATUSES,
  CONVERSATION_TYPES,
} from '../conversation.constants';

/**
 * Updates conversation attributes. Prefer the dedicated assign / archive /
 * unarchive endpoints for those transitions; `status`/`type` are accepted here
 * for administrative correction and validated against the allowed sets.
 */
export class UpdateConversationDto {
  @ApiPropertyOptional({ description: 'Conversation kind.', enum: CONVERSATION_TYPES, example: 'support' })
  @IsOptional()
  @IsIn(CONVERSATION_TYPES)
  type?: string;

  @ApiPropertyOptional({ description: 'Conversation status.', enum: CONVERSATION_STATUSES })
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Re-link the conversation to a branch (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
