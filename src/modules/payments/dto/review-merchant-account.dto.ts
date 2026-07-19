import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import { MERCHANT_ACCOUNT_STATUS } from '../payments.constants';

/**
 * Platform-admin merchant review action. `status` must be a legal transition
 * from the account's current status (validated by MerchantAccountService).
 */
export class ReviewMerchantAccountDto {
  @ApiPropertyOptional({
    description: 'Target onboarding status.',
    enum: Object.values(MERCHANT_ACCOUNT_STATUS),
  })
  @IsOptional()
  @IsIn(Object.values(MERCHANT_ACCOUNT_STATUS))
  status?: string;

  @ApiPropertyOptional({ description: 'Reviewer note (shown to the clinic).' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Gateway-issued split/payout recipient id for this clinic (Moyasar marketplace). Empty string clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  providerRecipientId?: string;
}
