import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_CHANNELS_LIST } from '../notification.constants';

/** Filter + pagination for listing templates (always tenant-scoped). */
export class NotificationTemplateFilterDto {
  @ApiPropertyOptional({ description: 'Case-insensitive partial match on name.', example: 'reminder', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter by template type.', example: 'appointment_reminder', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  type?: string;

  @ApiPropertyOptional({ description: 'Filter by channel.', enum: NOTIFICATION_CHANNELS_LIST, example: 'WHATSAPP' })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS_LIST)
  channel?: string;

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
