import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** contracts/public-surfaces.md §A `POST .../cancel` body. */
export class ConfirmCancellationDto {
  @ApiPropertyOptional({
    description: 'Optional reason the patient gives for cancelling.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
