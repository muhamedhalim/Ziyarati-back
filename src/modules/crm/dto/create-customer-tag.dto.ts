import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Create a tag for segmentation (name unique per tenant). */
export class CreateCustomerTagDto {
  @ApiProperty({ description: 'Tag name (unique per tenant).', example: 'VIP' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Display color (hex or token).', example: '#FFB300' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  color?: string;
}
