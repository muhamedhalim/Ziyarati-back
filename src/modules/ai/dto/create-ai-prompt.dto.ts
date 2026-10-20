import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AI_DIRECTIVE_LIMITS } from '../ai.constants';

/**
 * Creates an AI prompt.
 *
 * Schema note: `ai_prompts` has no `type`/`version` column, so prompt type and
 * versioning are not persisted (documented). Optional `agentId` assigns the
 * prompt to an agent.
 */
export class CreateAiPromptDto {
  @ApiPropertyOptional({ description: 'Prompt name/label.', example: 'Booking flow — greeting', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    description: 'Directive text, sent to the AI on every reply while active.',
    example: 'Greet the patient and ask which service they need.',
    maxLength: AI_DIRECTIVE_LIMITS.MAX_CONTENT_CHARS,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(AI_DIRECTIVE_LIMITS.MAX_CONTENT_CHARS)
  content!: string;

  @ApiPropertyOptional({ description: 'Assign to an agent (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @ApiPropertyOptional({ description: 'Whether the prompt is active. Defaults to true.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
