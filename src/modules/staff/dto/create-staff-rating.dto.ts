import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Records a rating for a staff member, tied to a COMPLETED appointment.
 * The customer is derived from the appointment; duplicates per appointment are
 * rejected.
 */
export class CreateStaffRatingDto {
  @ApiProperty({
    description: 'The completed appointment this rating is for. Must belong to the clinic and to this staff member.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000050',
  })
  @IsUUID()
  appointmentId!: string;

  @ApiProperty({
    description: 'Star rating, 1 (worst) to 5 (best).',
    example: 5,
    minimum: 1,
    maximum: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({
    description: 'Optional free-text feedback.',
    example: 'Very attentive and professional.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;
}
