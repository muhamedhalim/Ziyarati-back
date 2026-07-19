import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Update a training file's name or ingestion status. */
export class UpdateTrainingFileDto {
  @ApiPropertyOptional({ description: 'Updated file name.', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;

}
