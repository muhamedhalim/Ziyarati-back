import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TRAINING_FILE_STATUSES } from '../ai.constants';

/** Update a training file's name or ingestion status. */
export class UpdateTrainingFileDto {
  @ApiPropertyOptional({ description: 'Updated file name.', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

  @ApiPropertyOptional({ description: 'Ingestion status.', enum: TRAINING_FILE_STATUSES })
  @IsOptional()
  @IsIn(TRAINING_FILE_STATUSES)
  status?: string;
}
