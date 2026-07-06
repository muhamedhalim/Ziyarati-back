import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Escalates a conversation to human staff (status PENDING). At least one of
 * `conversationId` / `aiConversationId` is required — when only the AI
 * conversation is given and it has no linked messaging `Conversation` yet
 * (e.g. a website-widget chat), one is created automatically and linked, so
 * every channel gets a real Agent Inbox entry. Flips the AI conversation to
 * HANDED_OVER so the AI stops answering immediately.
 */
export class CreateHandoverRequestDto {
  @ApiPropertyOptional({ description: 'Messaging conversation to escalate (tenant-scoped). Omit to auto-create/derive from aiConversationId.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Reason for the handover.', example: 'Customer requested a human agent.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ description: 'AI conversation to mark HANDED_OVER (tenant-scoped). Required if conversationId is omitted.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  aiConversationId?: string;
}
