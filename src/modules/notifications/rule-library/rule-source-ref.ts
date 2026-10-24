import { AppointmentStatus } from '../../../entities/enums';

/**
 * Idempotency key of a row scheduled by a rule.
 *
 *   rule:{ruleId}:{kind}:{appointmentId}[:{startEpoch}]
 *
 * `scheduled_notifications.source_ref` carries a partial UNIQUE index, so the same
 * rule can never schedule the same logical message twice — an event re-emitted
 * (retry, replay, a double click on "confirm") returns the row that exists.
 *
 *  - `kind` is `before` for a "N minutes before the appointment" rule, otherwise
 *    the event name without its prefix (`confirmed`, `completed`, …).
 *  - `startEpoch` pins a `before` row to the appointment time it was computed for:
 *    when the appointment moves, the old row is cancelled and a new one is created
 *    under a different key, instead of the old key swallowing the new schedule.
 *
 * The same string is read back at dispatch time to re-check the appointment still
 * matches what was scheduled.
 */
export interface RuleSourceRef {
  ruleId: string;
  kind: string;
  appointmentId: string;
  startEpoch?: number;
}

export const RULE_REF_PREFIX = 'rule:';

export function buildRuleSourceRef(ref: RuleSourceRef): string {
  const base = `${RULE_REF_PREFIX}${ref.ruleId}:${ref.kind}:${ref.appointmentId}`;
  return ref.startEpoch === undefined ? base : `${base}:${ref.startEpoch}`;
}

export function parseRuleSourceRef(
  sourceRef: string | null | undefined,
): RuleSourceRef | null {
  if (!sourceRef?.startsWith(RULE_REF_PREFIX)) return null;
  const parts = sourceRef.split(':');
  if (parts.length < 4 || parts.length > 5) return null;
  const [, ruleId, kind, appointmentId, epoch] = parts;
  const startEpoch = epoch === undefined ? undefined : Number(epoch);
  if (startEpoch !== undefined && !Number.isFinite(startEpoch)) return null;
  return { ruleId, kind, appointmentId, startEpoch };
}

/** Event kind for a trigger, e.g. `appointment.completed` → `completed`. */
export function kindOfTrigger(trigger: string): string {
  return trigger.replace(/^appointment\./, '');
}

/** SQL LIKE pattern for every still-pending "before the appointment" row of one appointment. */
export function beforeRowsPattern(appointmentId: string): string {
  return `${RULE_REF_PREFIX}%:before:${appointmentId}:%`;
}

export interface AppointmentSnapshot {
  status: AppointmentStatus | string;
  start_at: Date;
  /** `YYYY-MM-DD` (a `date` column); only judged for follow-up rows. */
  follow_up_due_on?: string | null;
}

/**
 * Does the appointment still match the moment this row was scheduled for?
 * Returns the reason it no longer does, or `null` when it is fine to send.
 *
 * Re-read at send time because everything between scheduling and sending can
 * change: it may be cancelled, completed early, marked no-show, or moved.
 */
export function staleReason(
  ref: RuleSourceRef,
  appt: AppointmentSnapshot | null | undefined,
): 'APPOINTMENT_CHANGED' | null {
  // Only appointment-driven rows are judged against an appointment. Rows with
  // no appointment (a re-engagement message is about a patient, not a booking)
  // have nothing to go stale.
  const appointmentKinds = [
    'before',
    'completed',
    'confirmed',
    'created',
    'followup',
  ];
  if (!appointmentKinds.includes(ref.kind)) return null;
  if (!appt) return 'APPOINTMENT_CHANGED';
  // A follow-up row was scheduled for ONE date on ONE completed visit. If the
  // clinician cleared or moved the date (or the visit is no longer completed) in
  // the meantime, the invitation no longer reflects what they decided.
  if (ref.kind === 'followup') {
    const due = appt.follow_up_due_on
      ? Date.UTC(
          Number(appt.follow_up_due_on.slice(0, 4)),
          Number(appt.follow_up_due_on.slice(5, 7)) - 1,
          Number(appt.follow_up_due_on.slice(8, 10)),
        )
      : null;
    return appt.status === AppointmentStatus.COMPLETED &&
      due !== null &&
      due === ref.startEpoch
      ? null
      : 'APPOINTMENT_CHANGED';
  }
  const status = appt.status as string;
  const dead =
    status === AppointmentStatus.CANCELLED ||
    status === AppointmentStatus.NO_SHOW;

  if (ref.kind === 'before') {
    if (dead || status === AppointmentStatus.COMPLETED) {
      return 'APPOINTMENT_CHANGED';
    }
    if (
      ref.startEpoch !== undefined &&
      new Date(appt.start_at).getTime() !== ref.startEpoch
    ) {
      return 'APPOINTMENT_CHANGED';
    }
    return null;
  }
  // A follow-up after the visit only makes sense for a visit that happened.
  if (ref.kind === 'completed') {
    return status === AppointmentStatus.COMPLETED
      ? null
      : 'APPOINTMENT_CHANGED';
  }
  // A confirmation that was delayed must not go out for a cancelled booking.
  if (ref.kind === 'confirmed' || ref.kind === 'created') {
    return dead ? 'APPOINTMENT_CHANGED' : null;
  }
  return null;
}
