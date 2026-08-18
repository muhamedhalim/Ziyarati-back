import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Admin-owned catalog fields only — `item_key`/`kind`/`unit_label`/`unit_size`
 * are code-owned (derived from the sellable-resource registry) and are never
 * writable here; the bootstrap sync is the only thing that sets them.
 */
export class UpdateResourcePriceDto {
  @ApiPropertyOptional({
    description: 'Price per unit, in MINOR currency units (e.g. halalas). Must be > 0 to activate the item.',
    example: 5000,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  unitPriceMinor?: number;

  @ApiPropertyOptional({ description: 'Minimum purchasable quantity.', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  minQuantity?: number;

  @ApiPropertyOptional({ description: 'Maximum purchasable quantity (null = no cap).' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxQuantity?: number;

  @ApiPropertyOptional({ description: 'ISO currency code.', default: 'SAR' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ description: 'Display order in the catalog UI.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}
