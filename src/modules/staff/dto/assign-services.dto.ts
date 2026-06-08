import { ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Replaces the full set of services a staff member can perform (idempotent set
 * semantics). Every service must belong to the caller's clinic and be active.
 */
export class AssignServicesDto {
  @ApiProperty({
    description:
      'Complete list of service UUIDs the staff member is qualified to perform. This REPLACES the existing set. Pass an empty array to clear all.',
    example: [
      'c1d2e3f4-0000-0000-0000-000000000040',
      'c1d2e3f4-0000-0000-0000-000000000041',
    ],
    type: [String],
    format: 'uuid',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  serviceIds!: string[];
}
