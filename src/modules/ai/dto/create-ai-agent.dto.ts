import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AI_MODEL_IDS } from '../routing/ai-model-registry';

/**
 * Creates an AI agent for the caller's tenant. The tenant comes from the
 * authenticated principal — no tenantId field; the branch is validated against
 * the tenant.
 */
export class CreateAiAgentDto {
  @ApiPropertyOptional({ description: 'Agent display name.', example: 'Reception Assistant', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  /**
   * Constrained to AI_MODEL_REGISTRY ids. This used to be free text, so a clinic
   * admin could persist any string here — it reached the provider verbatim and,
   * when unrecognized, produced UNPRICED cost rows (or a hard provider error).
   * `MaxLength` is kept for the column bound; `IsIn` is the real gate.
   */
  @ApiPropertyOptional({
    description: 'Model identifier. Must be one of the platform-registered models.',
    example: 'gpt-4.1-mini',
    enum: AI_MODEL_IDS,
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @IsIn([...AI_MODEL_IDS], {
    message: `model must be one of: ${AI_MODEL_IDS.join(', ')}`,
  })
  model?: string;

  @ApiPropertyOptional({ description: 'System instructions / persona for the agent.', example: 'You are a helpful clinic receptionist...' })
  @IsOptional()
  @IsString()
  systemPrompt?: string;

  @ApiPropertyOptional({ description: 'Sampling temperature (0–2). Defaults to 0.2.', example: 0.2, minimum: 0, maximum: 2, default: 0.2 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: 'Restrict the agent to a branch (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Whether the agent is active. Defaults to true.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
