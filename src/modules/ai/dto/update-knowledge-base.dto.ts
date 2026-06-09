import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Partial update of a knowledge-base chunk (the owning agent is immutable). */
export class UpdateKnowledgeBaseDto {
  @ApiPropertyOptional({ description: 'Updated knowledge content.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  content?: string;

  @ApiPropertyOptional({ description: 'Origin type.', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @ApiPropertyOptional({ description: 'Origin id.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sourceId?: string;
}
