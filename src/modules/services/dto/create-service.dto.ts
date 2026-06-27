import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

import { PricingType } from '../../../entities/Services/Service';

/**
 * Create a bookable service for the caller's tenant.
 *
 * Tenant is NEVER taken from input — it comes from TenantContext. `name` is
 * unique per tenant. `durationMinutes` drives the appointment `endAt`
 * computation; `basePrice` is snapshotted onto the appointment at booking time.
 * When `categoryId` is supplied it must reference an active category owned by the
 * same tenant.
 *
 * Field casing follows the project-wide DTO convention: camelCase request fields
 * mapped to snake_case columns in the service layer.
 */
export class CreateServiceDto {
  @ApiProperty({ description: 'Service name (unique per tenant).', example: "Men's Haircut" })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description.', example: 'Includes wash and styling.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Duration in minutes (must be greater than 0).', example: 30, minimum: 1 })
  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @ApiPropertyOptional({
    description: 'Pricing model. FIXED uses `basePrice`; VARIABLE is priced per booking.',
    enum: PricingType,
    example: PricingType.FIXED,
    default: PricingType.FIXED,
  })
  @IsOptional()
  @IsEnum(PricingType)
  pricingType?: PricingType;

  @ApiPropertyOptional({ description: 'Base price (>= 0). Snapshotted onto appointments at booking.', example: 80, minimum: 0 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  basePrice?: number;

  @ApiPropertyOptional({ description: 'Owning category UUID (must be active and tenant-owned).', format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Whether the service is active and bookable.', example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
