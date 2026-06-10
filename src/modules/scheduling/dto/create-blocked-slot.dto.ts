import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Create a blocked period. `branchId`/`staffId` are both optional (schema):
 *  - both set → blocks that staff at that branch,
 *  - staff only → blocks that staff everywhere,
 *  - branch only → blocks the whole branch,
 *  - neither → a tenant-wide block (e.g. maintenance).
 */
export class CreateBlockedSlotDto {
  @ApiPropertyOptional({ description: 'Branch the block applies to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ description: 'Staff the block applies to.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiProperty({ description: 'Block start (ISO-8601).', example: '2026-07-01T00:00:00Z' })
  @IsISO8601()
  startTime!: string;

  @ApiProperty({ description: 'Block end (ISO-8601). Must be after start.', example: '2026-07-10T23:59:59Z' })
  @IsISO8601()
  endTime!: string;

  @ApiPropertyOptional({ description: 'Reason for the block.', example: 'Doctor vacation' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
