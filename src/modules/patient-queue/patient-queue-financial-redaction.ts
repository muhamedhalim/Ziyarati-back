import { QueueEntryView, QueueListResult } from './patient-queue.service';

/**
 * Nurse role — response-boundary financial redaction, the queue's own
 * counterpart to `appointment-financial-redaction.ts`. `QueueEntryView`
 * carries exactly one financial field: `appointment.paymentStatus`.
 * `canViewAppointmentFinancials` (rbac.constants.ts) decides who; `delete`d
 * rather than nulled for the same reason as the appointment module — an
 * absent field reads as "withheld", a `null` could read as "unpaid".
 */
export function redactQueueEntryFinancials(
  view: QueueEntryView,
  canView: boolean,
): QueueEntryView {
  if (canView) return view;
  delete (view.appointment as unknown as Record<string, unknown>)
    .paymentStatus;
  return view;
}

export function redactQueueListFinancials(
  result: QueueListResult,
  canView: boolean,
): QueueListResult {
  if (canView) return result;
  for (const entry of result.data) redactQueueEntryFinancials(entry, canView);
  return result;
}
