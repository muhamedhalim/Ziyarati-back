import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Add an address to a customer (1:N). Setting `is_default` unsets the others. */
export class CreateCustomerAddressDto {
  @ApiPropertyOptional({ description: 'Label.', example: 'Home' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @ApiPropertyOptional({ description: 'Address line (free text).' })
  @IsOptional()
  @IsString()
  address_line?: string;

  @ApiPropertyOptional({ description: 'City.', example: 'Riyadh' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({ description: 'Mark as the default address.', example: false, default: false })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;
}
