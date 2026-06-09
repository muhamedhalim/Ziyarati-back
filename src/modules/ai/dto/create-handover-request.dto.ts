import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Escalates a conversation to human staff (status PENDING). `conversationId` is
 * the messaging `Conversation` (required by the schema). Optionally flips a
 * linked AI conversation to HANDED_OVER.
 */
export class CreateHandoverRequestDto {
  @ApiProperty({ description: 'Messaging conversation to escalate (tenant-scoped).', format: 'uuid' })
  @IsUUID()
  conversationId!: string;

  @ApiPropertyOptional({ description: 'Reason for the handover.', example: 'Customer requested a human agent.', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional({ description: 'AI conversation to mark HANDED_OVER (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  aiConversationId?: string;
}
