import { IsInt, IsISO8601, IsOptional, IsUUID, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Spec 014 (Clinic Platform Completion) — T161 (US9, contracts F9 `POST /waitlist`). */
export class CreateWaitlistEntryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  preferredStaffId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  preferredBranchId?: string;

  @ApiPropertyOptional({ description: 'Preferred window start (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  windowStart?: string;

  @ApiPropertyOptional({ description: 'Preferred window end (ISO-8601).' })
  @IsOptional()
  @IsISO8601()
  windowEnd?: string;

  @ApiPropertyOptional({ description: 'Higher is matched first.', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;
}
