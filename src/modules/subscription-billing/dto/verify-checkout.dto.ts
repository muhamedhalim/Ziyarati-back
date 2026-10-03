import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The return page hands back the provider's charge id (Tap appends `tap_id` to
 * the return URL). It is only a pointer: the server asks the provider about that
 * charge itself and never trusts anything else the client says.
 */
export class VerifyCheckoutDto {
  @ApiProperty({
    description:
      "The provider's charge id from the return URL (`tap_id`). Verified server-side.",
    example: 'chg_TS02A5020241234Ab1B0709823',
  })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]{4,64}$/, { message: 'chargeId is not a valid id' })
  chargeId!: string;
}
