import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min } from 'class-validator';

import { SELLABLE_ITEM_KEYS } from '../sellable-resource.registry';

export class PreviewResourcePurchaseDto {
  @ApiProperty({ description: 'The sellable-resource registry item key.', example: 'branches' })
  @IsIn(SELLABLE_ITEM_KEYS)
  itemKey!: string;

  @ApiProperty({ description: 'Number of catalog units to buy.', example: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;
}
