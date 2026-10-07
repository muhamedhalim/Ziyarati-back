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

/** Filter + pagination for listing staff (always tenant-scoped). */
export class QueryStaffDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive partial match on the staff title.',
    example: 'derma',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by booking availability. Pass `true` or `false`.',
    example: 'true',
  })
  @IsOptional()
  @IsBooleanString()
  isAvailable?: string;

  @ApiPropertyOptional({
    description: 'Filter to staff assigned to a specific branch.',
    format: 'uuid',
    example: 'c1d2e3f4-0000-0000-0000-000000000010',
  })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description:
      'Filter to staff whose linked account currently holds this role slug (e.g. `doctor`). Combines with `branchId` as an AND — a staff member must match every filter given.',
    example: 'doctor',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  role?: string;

  @ApiPropertyOptional({
    description:
      'Pass `true` to list only staff who may be booked as the provider of a NEW appointment — accounts holding the `branch_manager`, `doctor` or `nurse` role. The clinic owner, receptionists and all other roles are excluded. Combines with `role` and `branchId` as an AND. The role set is defined server-side; it is not client-configurable.',
    example: 'true',
  })
  @IsOptional()
  @IsBooleanString()
  bookable?: string;

  @ApiPropertyOptional({
    description: 'Page number (1-based).',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Results per page. Max 100.',
    example: 20,
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
