import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsUUID, Min } from 'class-validator';

import { SELLABLE_ITEM_KEYS } from '../sellable-resource.registry';

/**
 * Takes NO price input (plan §13/§19) — the final price is always computed
 * server-side from the catalog snapshot. `idempotencyKey` is CLIENT-generated
 * (`crypto.randomUUID()`, regenerated only after a terminal outcome), a
 * SEPARATE field from `itemKey`/`quantity` — never derived from them.
 */
export class CreateResourcePurchaseDto {
  @ApiProperty({ description: 'The sellable-resource registry item key.', example: 'branches' })
  @IsIn(SELLABLE_ITEM_KEYS)
  itemKey!: string;

  @ApiProperty({ description: 'Number of catalog units to buy.', example: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({
    description:
      'Client-generated UUIDv4, one per purchase ATTEMPT (not per itemKey+quantity). A double-click with the SAME key returns the same purchase; a new attempt uses a new key.',
  })
  @IsUUID('4')
  idempotencyKey!: string;
}
