import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { AI_CHANNELS } from '../ai-channel.constants';
import type { AiChannel, AiSession } from '../ai-channel.constants';

/** A single cross-channel AI turn routed through the orchestrator. */
export class OrchestrateMessageDto {
  @ApiProperty({ enum: AI_CHANNELS, description: 'Origin channel.' })
  @IsIn(AI_CHANNELS as unknown as string[])
  channel!: AiChannel;

  @ApiProperty({ description: 'User message content.', minLength: 1, maxLength: 8000 })
  @IsString() @MinLength(1) @MaxLength(8000)
  content!: string;

  @ApiPropertyOptional({ description: 'Stable retry key for this logical AI turn.', maxLength: 120 })
  @IsOptional() @IsString() @MinLength(8) @MaxLength(120)
  idempotencyKey?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Resume an existing AI conversation.' })
  @IsOptional() @IsUUID()
  aiConversationId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Bind a new session to this agent.' })
  @IsOptional() @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Bind to a unified messaging conversation.' })
  @IsOptional() @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Preferred language (e.g. `en`, `ar`).' })
  @IsOptional() @IsString() @MaxLength(12)
  language?: string;

  @ApiPropertyOptional({ description: 'Client device (e.g. `web`, `ios`, `android`).' })
  @IsOptional() @IsString() @MaxLength(32)
  device?: string;

  @ApiPropertyOptional({ description: 'End-user IANA timezone (e.g. `Africa/Cairo`).' })
  @IsOptional() @IsString() @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ description: 'Re-route to the best specialized agent on this turn.' })
  @IsOptional() @IsBoolean()
  autoRoute?: boolean;

  @ApiPropertyOptional({ description: 'Recall long-term memory for this turn and attach it to context.' })
  @IsOptional() @IsBoolean()
  useMemory?: boolean;

  @ApiPropertyOptional({
    description: 'Client session updates (e.g. selectedClinicId, selectedBranchId, currentIntent).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional() @IsObject()
  sessionPatch?: Partial<AiSession>;
}

/** Patch active session state without sending a message. */
export class PatchSessionDto {
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Partial session state to merge.' })
  @IsObject()
  session!: Partial<AiSession>;
}
