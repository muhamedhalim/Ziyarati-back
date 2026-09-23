import { Appointment } from '../../entities/Calendar&Appointments/Appointment';
import { TimelineEntry } from './appointment.service';

/**
 * Nurse role — response-boundary financial redaction.
 *
 * `canViewAppointmentFinancials` (rbac.constants.ts) decides WHO; this file
 * decides WHAT gets removed and WHERE it is applied. Deliberately a
 * CONTROLLER-layer concern, never inside `AppointmentService` itself: every
 * internal write path (create/update/cancel/reschedule/status change) calls
 * `findOne`/`findAll` and must keep seeing the FULL row regardless of who
 * triggered it — redaction only ever touches what a controller hands back
 * to the HTTP response.
 *
 * `delete`s each key rather than nulling it, so an absent field in the
 * response documents "you may not see this" unambiguously — a `null`
 * `total_amount` could otherwise be misread as "this appointment is free".
 * Safe to mutate in place: every caller here passes an entity/plain object
 * freshly loaded for THIS one request/response, never a shared or cached
 * reference another concurrent request could observe.
 */

/** Appointment fields withheld when `canViewAppointmentFinancials` is false. */
export function redactAppointmentFinancials<T extends Appointment>(
  appointment: T,
  canView: boolean,
): T {
  if (canView || !appointment) return appointment;
  const a = appointment as unknown as Record<string, unknown>;
  delete a.total_amount;
  delete a.payment_status;
  delete a.currency;
  for (const line of appointment.services ?? []) {
    const l = line as unknown as Record<string, unknown>;
    delete l.price;
    if (line.service) {
      const s = line.service as unknown as Record<string, unknown>;
      delete s.base_price;
      delete s.pricing_type;
    }
  }
  return appointment;
}

/** Same redaction, applied to every row of a list response. */
export function redactAppointmentListFinancials<T extends Appointment>(
  appointments: T[],
  canView: boolean,
): T[] {
  if (canView) return appointments;
  for (const a of appointments) redactAppointmentFinancials(a, canView);
  return appointments;
}

/**
 * A cancellation timeline entry carries `data.refundAmount` — the one
 * financial field in `GET /appointments/:id/timeline`. Returns NEW entry
 * objects (never mutates `TimelineEntry.data`, a plain `Record` the caller
 * may still hold a reference to elsewhere) with the key omitted.
 */
export function redactTimelineFinancials(
  entries: TimelineEntry[],
  canView: boolean,
): TimelineEntry[] {
  if (canView) return entries;
  return entries.map((entry) => {
    if (entry.type !== 'cancellation' || !('refundAmount' in entry.data)) {
      return entry;
    }
    const { refundAmount: _refundAmount, ...rest } = entry.data;
    return { ...entry, data: rest };
  });
}
