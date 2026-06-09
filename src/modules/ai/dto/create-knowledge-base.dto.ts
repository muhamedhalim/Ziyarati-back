import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Creates a knowledge-base chunk for an agent (the entity stores content per
 * agent; there is no separate KB container). Tenant + agent validated server-side.
 */
export class CreateKnowledgeBaseDto {
  @ApiProperty({ description: 'Owning agent (tenant-scoped).', format: 'uuid' })
  @IsUUID()
  agentId!: string;

  @ApiProperty({ description: 'Knowledge content (text chunk).', example: 'Our clinic is open Sun–Thu, 9am–9pm.' })
  @IsString()
  @MinLength(1)
  content!: string;

  @ApiPropertyOptional({ description: 'Origin type, e.g. `training_file`, `manual`, `faq`.', example: 'manual', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @ApiPropertyOptional({ description: 'Origin id (e.g. training file UUID).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}
