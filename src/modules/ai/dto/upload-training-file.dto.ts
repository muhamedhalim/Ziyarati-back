import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SUPPORTED_FILE_TYPES } from '../ai.constants';

/**
 * Registers a training file (metadata only — no storage implementation). Upload
 * the file to your storage provider first, then pass the resulting URL here.
 */
export class UploadTrainingFileDto {
  @ApiProperty({ description: 'Original file name.', example: 'clinic-faq.pdf', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ description: 'Tenant-owned private R2 object key (external URLs are rejected).', example: 'tenant-uuid/ai_training/clinic-faq.txt' })
  @IsString()
  @MinLength(1)
  fileUrl!: string;

  @ApiPropertyOptional({ description: 'File type.', enum: SUPPORTED_FILE_TYPES, example: 'PDF' })
  @IsOptional()
  @IsIn(SUPPORTED_FILE_TYPES as unknown as string[])
  fileType?: string;

  @ApiPropertyOptional({ description: 'Associate the file with an agent (tenant-scoped).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  agentId?: string;
}
