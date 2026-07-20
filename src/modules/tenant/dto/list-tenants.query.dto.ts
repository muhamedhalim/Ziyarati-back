import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TenantApprovalStatus } from '../../../entities/enums';

/** Platform-admin filter/pagination for listing tenants. */
export class ListTenantsQueryDto {
  @ApiPropertyOptional({
    description: 'Filter results by approval lifecycle status.',
    enum: TenantApprovalStatus,
    example: TenantApprovalStatus.PENDING_APPROVAL,
  })
  @IsOptional()
  @IsEnum(TenantApprovalStatus)
  status?: TenantApprovalStatus;

  @ApiPropertyOptional({
    description: 'Case-insensitive partial match on clinic name or slug.',
    example: 'al-noor',
    maxLength: 255,
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(255)
  search?: string;

  @ApiPropertyOptional({
    description: 'Page number for pagination (1-based).',
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
    description: 'Number of results per page. Maximum 100.',
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
