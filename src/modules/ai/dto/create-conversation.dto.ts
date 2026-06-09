import { IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Starts an AI conversation (status ACTIVE). Optionally bound to an agent and to
 * a messaging `Conversation` (shared thread). Both validated against the tenant.
 */
export class CreateConversationDto {
  @ApiPropertyOptional({ description: 'Agent driving the conversation (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Linked messaging conversation (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
