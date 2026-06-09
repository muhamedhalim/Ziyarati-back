import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Removes recipients from a campaign by their customer ids (scoped to the campaign). */
export class RemoveCampaignRecipientsDto {
  @ApiProperty({
    description: 'Customer UUIDs to remove from the campaign\'s recipient list.',
    example: ['c1d2e3f4-0000-0000-0000-000000000020'],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  customerIds!: string[];
}
