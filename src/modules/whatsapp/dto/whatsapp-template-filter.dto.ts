import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WHATSAPP_TEMPLATE_STATUSES } from '../whatsapp.constants';

/** Filter + pagination for listing templates (always tenant-scoped). */
export class WhatsappTemplateFilterDto {
  @ApiPropertyOptional({ description: 'Filter by review status.', enum: WHATSAPP_TEMPLATE_STATUSES, example: 'approved' })
  @IsOptional()
  @IsIn(WHATSAPP_TEMPLATE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by category.', example: 'UTILITY', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @ApiPropertyOptional({ description: 'Filter by language.', example: 'ar', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  language?: string;

  @ApiPropertyOptional({ description: 'Case-insensitive partial match on name.', example: 'reminder', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based).', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Results per page. Max 100.', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
