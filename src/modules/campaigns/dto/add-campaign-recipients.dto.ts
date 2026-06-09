import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Adds customers to a campaign as recipients (bulk import). Idempotent: existing
 * (campaign, customer) pairs are skipped via the unique constraint. Every
 * customer is validated to belong to the caller's tenant.
 */
export class AddCampaignRecipientsDto {
  @ApiProperty({
    description: 'Customer UUIDs to enroll as recipients. Must belong to the caller\'s tenant. Duplicates already on the campaign are ignored.',
    example: [
      'c1d2e3f4-0000-0000-0000-000000000020',
      'c1d2e3f4-0000-0000-0000-000000000021',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  customerIds!: string[];
}
