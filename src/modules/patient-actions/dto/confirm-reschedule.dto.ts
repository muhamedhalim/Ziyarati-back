import { IsISO8601 } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** contracts/public-surfaces.md §A `POST .../reschedule` body. Deliberately
 *  carries ONLY `startAt` — branch, service and staff are never accepted
 *  from the caller (FR-R004); they are always read from the existing
 *  appointment. */
export class ConfirmRescheduleDto {
  @ApiProperty({
    description: 'The new start time the patient is confirming (ISO-8601).',
    example: '2026-06-12T11:00:00+03:00',
  })
  @IsISO8601()
  startAt!: string;
}
