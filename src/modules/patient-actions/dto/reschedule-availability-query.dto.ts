import { IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** contracts/public-surfaces.md §A `GET .../availability` query. The
 *  horizon cap (`PUBLIC_AVAILABILITY_HORIZON_DAYS`) is enforced server-side
 *  by `AvailabilityService.publicWindows` regardless of what `to` requests. */
export class RescheduleAvailabilityQueryDto {
  @ApiProperty({ description: 'Start date (YYYY-MM-DD).', example: '2026-06-01' })
  @IsDateString()
  from!: string;

  @ApiProperty({ description: 'End date (YYYY-MM-DD), capped server-side.', example: '2026-06-14' })
  @IsDateString()
  to!: string;
}
