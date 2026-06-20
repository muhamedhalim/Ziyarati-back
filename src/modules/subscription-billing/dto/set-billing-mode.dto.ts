import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { BillingMode } from '../platform-billing.constants';

/** Switch the global platform billing mode (super-admin only). */
export class SetBillingModeDto {
  @ApiProperty({
    enum: BillingMode,
    description:
      '`free` = open platform, no subscription required (enforcement off). `paid` = subscription/entitlements enforced.',
    example: BillingMode.PAID,
  })
  @IsEnum(BillingMode)
  mode!: BillingMode;
}
