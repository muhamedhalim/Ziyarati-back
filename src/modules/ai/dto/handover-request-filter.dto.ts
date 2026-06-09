import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { HANDOVER_STATUSES } from '../ai.constants';

/** Filter + pagination for handover requests (always tenant-scoped). */
export class HandoverRequestFilterDto {
  @ApiPropertyOptional({ description: 'Filter by status.', enum: HANDOVER_STATUSES })
  @IsOptional()
  @IsIn(HANDOVER_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by assigned staff user.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

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
