import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { PatientActionPurpose } from '../../entities/enums';
import { PatientActionLinkService } from '../patient-actions/patient-action-link.service';

/**
 * Spec 014 (Clinic Platform Completion) — T032/T044/T054 (S1/S2/S3). Issues
 * a patient-action link and returns its URL as a template variable, shared
 * by every outbound message that must carry one: the booking confirmation
 * (`NotificationEventListener`) and each reminder (`ReminderSchedulerService`).
 * Extracted here rather than duplicated so both keep the exact same
 * failure-is-swallowed behaviour (a broken link must never block the
 * message it would have accompanied) and the same `appUrl()` base.
 */
@Injectable()
export class PatientActionLinkVariablesService {
  private readonly logger = new Logger(PatientActionLinkVariablesService.name);

  constructor(
    private readonly patientActionLinks: PatientActionLinkService,
    private readonly config: ConfigService,
  ) {}

  /** Base URL for links embedded in outbound messages (APP_URL, else first
   *  FRONTEND_ORIGIN) — same pattern as `AuthService.appUrl`. */
  appUrl(): string {
    return (
      this.config.get<string>('APP_URL') ??
      (this.config.get<string>('FRONTEND_ORIGIN') ?? 'http://localhost:3000')
        .split(',')[0]
        .trim()
    );
  }

  /**
   * Issues a `CANCEL` and a `RESCHEDULE` link for the appointment and
   * returns `{cancelUrl, rescheduleUrl}` (only the URLs that were issued
   * successfully — a failure on one never blocks the other, or the message
   * itself). Never throws.
   */
  async buildLinkVariables(
    tenantId: string,
    appointment: Appointment,
  ): Promise<Record<string, unknown>> {
    const [cancelUrl, rescheduleUrl] = await Promise.all([
      this.buildOne(
        tenantId,
        appointment,
        PatientActionPurpose.CANCEL,
        'cancelUrl',
      ),
      this.buildOne(
        tenantId,
        appointment,
        PatientActionPurpose.RESCHEDULE,
        'rescheduleUrl',
      ),
    ]);
    return { ...cancelUrl, ...rescheduleUrl };
  }

  private async buildOne(
    tenantId: string,
    appointment: Appointment,
    purpose: PatientActionPurpose,
    variableName: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const secret = await this.patientActionLinks.issue(
        tenantId,
        appointment,
        purpose,
      );
      return {
        [variableName]: `${this.appUrl()}/appointment-action/${secret}`,
      };
    } catch (err) {
      this.logger.error(
        `Failed to issue a ${purpose} link for appointment ${appointment.id}: ${(err as Error)?.message}`,
      );
      return undefined;
    }
  }
}
