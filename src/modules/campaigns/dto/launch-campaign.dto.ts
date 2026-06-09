import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Immediately launches a campaign (status → RUNNING). */
export class LaunchCampaignDto {
  @ApiPropertyOptional({
    description:
      'Launch even if the campaign has zero recipients (otherwise a 422 is returned to prevent empty sends). Defaults to false.',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
