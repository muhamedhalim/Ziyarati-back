import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WHATSAPP_ACCOUNT_MODES } from '../whatsapp.constants';

/** Filter + pagination for listing WhatsApp accounts (always tenant-scoped). */
export class WhatsappAccountFilterDto {
  @ApiPropertyOptional({ description: 'Filter to a specific branch.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Filter by account mode.', enum: WHATSAPP_ACCOUNT_MODES })
  @IsOptional()
  @IsIn(WHATSAPP_ACCOUNT_MODES)
  mode?: string;

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
