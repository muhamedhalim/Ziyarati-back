import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Create a customer review for a COMPLETED appointment. One review per
 * appointment (enforced by a 1:1 relation). The customer is derived from the
 * appointment — never trusted from the request.
 */
export class CreateReviewDto {
  @ApiProperty({
    description: 'Star rating from 1 (worst) to 5 (best).',
    example: 5,
    minimum: 1,
    maximum: 5,
  })
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @ApiPropertyOptional({
    description: 'Optional free-text review comment.',
    example: 'Excellent service, very professional and on time.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  comment?: string;
}
