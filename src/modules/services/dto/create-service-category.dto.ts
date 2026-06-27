import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Create a service category for the caller's tenant.
 *
 * Tenant is NEVER taken from input — it comes from TenantContext. `name` is
 * unique per tenant (enforced in the service layer for a friendly 409).
 */
export class CreateServiceCategoryDto {
  @ApiProperty({ description: 'Category name (unique per tenant).', example: 'Hair' })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description.', example: 'All hair-related services' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ description: 'Whether the category is active.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
