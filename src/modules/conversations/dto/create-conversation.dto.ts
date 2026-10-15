import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  CONVERSATION_STATUS,
  CONVERSATION_STATUSES,
  CONVERSATION_TYPES,
} from '../conversation.constants';

/**
 * Creates a conversation for the caller's tenant. The tenant comes from the
 * authenticated principal — there is no tenantId field; all referenced
 * resources (branch / customer / WhatsApp account / assignee) are validated to
 * belong to that tenant.
 */
export class CreateConversationDto {
  @ApiPropertyOptional({
    description: 'Conversation kind.',
    enum: CONVERSATION_TYPES,
    example: 'support',
  })
  @IsOptional()
  @IsIn(CONVERSATION_TYPES)
  type?: string;

  @ApiPropertyOptional({
    description: 'Initial status. Defaults to OPEN for staff-created conversations.',
    enum: CONVERSATION_STATUSES,
    example: CONVERSATION_STATUS.OPEN,
    default: CONVERSATION_STATUS.OPEN,
  })
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Branch this conversation belongs to (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Customer this conversation is with (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ description: 'WhatsApp account the conversation is routed through (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  whatsappAccountId?: string;

  @ApiPropertyOptional({ description: 'User (agent) to assign the conversation to (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}
