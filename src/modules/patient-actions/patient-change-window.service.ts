import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TenantSetting } from '../../entities/SaaS-Core/TenantSetting';
import { AppError, ErrorCode } from '../../common/errors';

export const DEFAULT_CHANGE_WINDOW_HOURS = 24;

/**
 * The window rule itself, with no I/O: a patient may still change an
 * appointment while `now` is at or before `hours` before it starts. Exported so
 * the AI tool path applies the SAME comparison as the signed-link path instead
 * of carrying its own copy (F-05).
 */
export function isWithinChangeWindow(
  appointmentStartAt: Date,
  hours: number,
  now: number = Date.now(),
): boolean {
  return now <= appointmentStartAt.getTime() - hours * 3600_000;
}

/**
 * Spec 014 (Clinic Platform Completion) — FR-C007 / FR-R009: patient
 * cancellation and patient rescheduling enforce the same clinic-configured
 * change window (`tenant_settings.cancellation_hours`), evaluated against
 * the LIVE setting at request time, never at link-issue time. Shared here
 * so `PatientCancellationService` (S1) and `PatientRescheduleService` (S2)
 * both read the identical rule instead of each carrying its own copy.
 */
@Injectable()
export class PatientChangeWindowService {
  constructor(
    @InjectRepository(TenantSetting)
    private readonly tenantSettings: Repository<TenantSetting>,
  ) {}

  async getWindowHours(tenantId: string): Promise<number> {
    const settings = await this.tenantSettings.findOne({
      where: { tenant: { id: tenantId } },
    });
    return settings?.cancellation_hours ?? DEFAULT_CHANGE_WINDOW_HOURS;
  }

  async assertWithinWindow(tenantId: string, appointmentStartAt: Date): Promise<void> {
    const hours = await this.getWindowHours(tenantId);
    if (!isWithinChangeWindow(appointmentStartAt, hours)) {
      throw new AppError(ErrorCode.CONFLICT, {
        message: `Change window closed — must act at least ${hours}h before the appointment`,
        publicContext: { blockedReason: 'WINDOW_CLOSED' },
      });
    }
  }
}
