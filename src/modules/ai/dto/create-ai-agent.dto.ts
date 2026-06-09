import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ description: 'Model identifier (provider-agnostic label).', example: 'gpt-4o-mini', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
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
