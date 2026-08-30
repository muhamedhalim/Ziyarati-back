import { PartialType, OmitType } from '@nestjs/swagger';

import { CreateWaitlistEntryDto } from './create-waitlist-entry.dto';

/**
 * Spec 014 (Clinic Platform Completion) — T161 (US9, contracts F9
 * `PATCH /waitlist/:id`). `customerId`/`serviceId` are immutable after
 * creation — changing either is a different entry (they're also half of the
 * FR-W013 uniqueness key), so a genuine change means cancel-and-recreate,
 * not an update.
 */
export class UpdateWaitlistEntryDto extends PartialType(
  OmitType(CreateWaitlistEntryDto, ['customerId', 'serviceId'] as const),
) {}
