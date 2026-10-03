import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * The only input of the public return endpoint: the charge id the gateway put on
 * the redirect (`?tap_id=chg_…`). It is a lookup key, not a credential — the
 * server reports what the gateway says about it and nothing else.
 */
export class ConfirmPublicReturnDto {
  @ApiProperty({
    description: 'Gateway charge id from the return redirect.',
    example: 'chg_TS05A4120230736x9K22710693',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^chg_[A-Za-z0-9_-]{6,80}$/, { message: 'chargeId is not valid' })
  chargeId!: string;
}
