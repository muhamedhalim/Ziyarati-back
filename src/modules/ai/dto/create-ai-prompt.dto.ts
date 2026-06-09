import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiProperty({ description: 'Prompt content.', example: 'Greet the patient and ask which service they need.' })
  @IsString()
  @MinLength(1)
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
