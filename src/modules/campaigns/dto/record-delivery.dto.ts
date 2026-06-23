import { IsEnum, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

import { RecipientDelivery } from '../../../entities/enums';

/**
 * A single provider delivery callback. `providerRef` is the message id the
 * carrier echoes back (stored on the recipient at dispatch). `event` is the
 * delivery state being reported.
 */
export class RecordDeliveryDto {
  @ApiProperty({ description: 'Provider message id (recipient.provider_ref).', example: 'wamid.HBg...' })
  @IsString()
  @MaxLength(255)
  providerRef!: string;

  @ApiProperty({
    description: 'Delivery event from the provider.',
    enum: RecipientDelivery,
    example: RecipientDelivery.DELIVERED,
  })
  @IsEnum(RecipientDelivery)
  event!: RecipientDelivery;
}
