import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';

/**
 * Create a calendar slot — a concrete availability window for a staff member at
 * a branch. Schema note: slots store explicit `start_time`/`end_time` (timestamptz);
 * there are NO recurrence fields, so each slot is one datetime window.
 */
export class CreateCalendarSlotDto {
  @ApiProperty({ description: 'Branch the slot belongs to.', format: 'uuid' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({ description: 'Staff member the slot is for.', format: 'uuid' })
  @IsUUID()
  staffId!: string;

  @ApiProperty({ description: 'Window start (ISO-8601).', example: '2026-07-06T09:00:00Z' })
  @IsISO8601()
  startTime!: string;

  @ApiProperty({ description: 'Window end (ISO-8601). Must be after start.', example: '2026-07-06T17:00:00Z' })
  @IsISO8601()
  endTime!: string;

  @ApiPropertyOptional({ description: 'Whether the slot is available.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;
}
