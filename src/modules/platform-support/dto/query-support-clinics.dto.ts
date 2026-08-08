import { Type } from 'class-transformer';
import { IsBooleanString, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

import { TenantApprovalStatus } from '../../../entities/enums';
import {
  SUPPORT_CLINIC_DIRECTORY_MAX_PAGE_SIZE,
  SUPPORT_CLINIC_DIRECTORY_PAGE_SIZE,
} from '../platform-support.constants';

/**
 * Clinic directory query for Platform Customer Service.
 *
 * The directory exists so a support agent can find the clinic that just phoned
 * them — no ticket required. That makes SEARCH the primary interaction, and it
 * is why `search` matches contact email and phone as well as name and slug: a
 * caller identifies themselves by the number they are calling from far more
 * often than by their tenant slug.
 *
 * Matching happens server-side against the stored values. The RESPONSE never
 * widens because of it — see `SupportClinicDirectoryService` for the exact
 * projection.
 */
export class QuerySupportClinicsDto {
  @ApiPropertyOptional({ example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    example: SUPPORT_CLINIC_DIRECTORY_PAGE_SIZE,
    minimum: 1,
    maximum: SUPPORT_CLINIC_DIRECTORY_MAX_PAGE_SIZE,
    default: SUPPORT_CLINIC_DIRECTORY_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUPPORT_CLINIC_DIRECTORY_MAX_PAGE_SIZE)
  limit: number = SUPPORT_CLINIC_DIRECTORY_PAGE_SIZE;

  @ApiPropertyOptional({
    description: 'Partial match on clinic name, slug, contact email or contact phone.',
    example: 'bright smile',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by approval state.',
    enum: TenantApprovalStatus,
  })
  @IsOptional()
  @IsEnum(TenantApprovalStatus)
  approvalStatus?: TenantApprovalStatus;

  @ApiPropertyOptional({
    description: 'Filter by active state. Omit for both.',
    example: 'true',
  })
  @IsOptional()
  @IsBooleanString()
  isActive?: string;

  offset(): number {
    return (this.page - 1) * this.limit;
  }
}
