import { ApiProperty } from '@nestjs/swagger';
import { Matches, ValidateIf } from 'class-validator';

/**
 * Set or clear the date a patient should come back by. `dueOn` is a calendar date
 * (`YYYY-MM-DD`), or `null` to clear it. A real-calendar check (no 2026-02-31) and
 * the "not in the past" rule live in the service, which knows the clinic's zone.
 */
export class SetFollowUpDto {
  @ApiProperty({
    description:
      'Calendar date the patient should return by (YYYY-MM-DD), or null to remove the follow-up.',
    example: '2026-12-01',
    nullable: true,
    type: String,
  })
  @ValidateIf((_, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'dueOn must be YYYY-MM-DD or null',
  })
  dueOn!: string | null;
}
