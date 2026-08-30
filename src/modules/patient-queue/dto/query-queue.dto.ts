import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * F10 — `GET /queue`. `branchId` is REQUIRED (a queue is always scoped to
 * one branch's one business day); `staffId`/`date` narrow it further.
 */
export class QueryQueueDto {
  @ApiProperty({
    description: 'The branch whose live queue to read.',
    format: 'uuid',
  })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({
    description: "Narrow to one practitioner's own queue view (FR-Q013).",
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  staffId?: string;

  @ApiPropertyOptional({
    description:
      "Business date (YYYY-MM-DD). Defaults to the branch's current day.",
    example: '2032-04-14',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  date?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 200, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 200;
}
