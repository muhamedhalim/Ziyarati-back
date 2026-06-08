import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Replace the full set of services attached to an appointment (idempotent set
 * semantics). On save, `end_at` and `total_amount` are recomputed from the new
 * services' durations and prices.
 */
export class SetAppointmentServicesDto {
  @ApiProperty({
    description:
      'Complete list of service UUIDs for the appointment. This REPLACES the existing services entirely. Each service must belong to the caller\'s clinic and be active.',
    example: [
      'c1d2e3f4-0000-0000-0000-000000000040',
      'c1d2e3f4-0000-0000-0000-000000000042',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  serviceIds!: string[];
}
