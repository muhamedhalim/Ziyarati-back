import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** A single line item. `total_price` is computed server-side (qty × unitPrice). */
export class InvoiceItemInputDto {
  @ApiProperty({ description: 'Line description.', example: 'Consultation fee' })
  @IsString()
  @MaxLength(255)
  description!: string;

  @ApiProperty({ description: 'Quantity (≥ 1).', example: 1, minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number = 1;

  @ApiProperty({ description: 'Unit price in major units (≥ 0).', example: 120.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice!: number;
}

/** Add one or more line items to a DRAFT invoice. */
export class AddInvoiceItemsDto {
  @ApiProperty({ description: 'Line items to add.', type: [InvoiceItemInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemInputDto)
  items!: InvoiceItemInputDto[];
}
