import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Filter + pagination for listing rules (always tenant-scoped). */
export class NotificationRuleFilterDto {
  @ApiPropertyOptional({ description: 'Filter by trigger event (partial match).', example: 'appointment', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  triggerEvent?: string;

  @ApiPropertyOptional({ description: 'Filter by the template used.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ description: 'Filter by active state. `true` or `false`.', example: 'true' })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

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
