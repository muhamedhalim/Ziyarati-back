import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Query for the booking-availability selector (`GET /services/available`).
 *
 * Returns active services, optionally narrowed to those a specific staff member
 * is qualified to perform (`staffId` → `staff_services`) and/or a category. This
 * is the preferred selector for Appointment / AI / WhatsApp booking — it answers
 * "what can actually be booked here?" rather than dumping the whole catalog.
 *
 * NOTE: `branchId` is intentionally NOT supported — the current schema has no
 * service↔branch relationship (only the unused per-branch ServicePrice). Adding
 * it requires a branch-pricing/service-branch model decision (see report).
 */
export class AvailableServicesDto {
  @ApiPropertyOptional({ description: 'Restrict to services this staff member can perform.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  staffId?: string;

  @ApiPropertyOptional({ description: 'Restrict to a single category.', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Partial match on service name.', example: 'hair' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({ description: 'Max results to return. Max 200.', example: 50, minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 50;
}
