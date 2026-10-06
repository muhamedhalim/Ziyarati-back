/**
 * Retention targets (residency plan P12).
 *
 * The MECHANISM for "delete this kind of data once it is N days old", with NO
 * built-in values: a target is inert until its `RETENTION_*_DAYS` setting is
 * given, because how long a clinic must or may keep a record is a legal input
 * (plan L12) and is never guessed here.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 * There is no target for clinical records (D4), patient identity (D2/D3),
 * payments or invoices (D5), or the audit trails (D7). Those are removed only by
 * an explicit data-subject deletion (`subject-erasure`) or tenant offboarding —
 * never by an age-based sweep that could erase a record a clinic is required to
 * keep. `NEVER_AUTO_PURGED` records that decision and `retention-policy.spec.ts`
 * enforces it.
 *
 * ── WHAT IS HERE ────────────────────────────────────────────────────────────
 * Operational copies that nothing else already ages out: delivery logs that hold
 * recipient addresses and template variables, raw inbound webhook payloads, and
 * AI chat transcripts. (API logs, notification logs, webhook logs, analytics
 * events and AI tool calls already have their own retention settings and
 * sweeps; they are not duplicated.)
 *
 * Existing retention in this codebase defaults to a number of days; these
 * targets do NOT — an unset target means "keep", which is the only safe default
 * when the right period is undecided.
 */

import type { DataClass } from './data-classification';

export type RetentionAction = 'delete' | 'scrub';

export interface RetentionTarget {
  /** Stable id; also the suffix of the setting `RETENTION_<ID>_DAYS`. */
  id: string;
  table: string;
  dataClasses: DataClass[];
  action: RetentionAction;
  /** Timestamp column the age is measured on. */
  timestampColumn: string;
  /** Extra `WHERE` fragment that restricts WHICH aged rows are eligible. */
  eligible?: string;
  /** `SET` clause for `scrub`. */
  set?: string;
  /** Why this is safe to age out on a schedule. */
  rationale: string;
}

/** `RETENTION_EMAIL_LOGS_DAYS` for target id `EMAIL_LOGS`. */
export function settingFor(target: RetentionTarget): string {
  return `RETENTION_${target.id}_DAYS`;
}

export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  {
    id: 'EMAIL_LOGS',
    table: 'email_logs',
    dataClasses: ['D2', 'D8'],
    action: 'delete',
    timestampColumn: 'created_at',
    rationale:
      'Delivery log: recipient address, subject and the template variables. Idempotency only matters within a send window.',
  },
  {
    id: 'WHATSAPP_WEBHOOKS',
    table: 'whatsapp_webhooks',
    dataClasses: ['D2', 'D8'],
    action: 'delete',
    timestampColumn: 'created_at',
    eligible: `"processed" = true`,
    rationale:
      'Raw inbound provider payload, kept only for replay and debugging. Unprocessed events are never touched.',
  },
  {
    id: 'SCHEDULED_NOTIFICATION_VARIABLES',
    table: 'scheduled_notifications',
    dataClasses: ['D2'],
    action: 'scrub',
    timestampColumn: 'created_at',
    set: `"variables" = '{}'::jsonb, "failure_reason" = NULL`,
    eligible: `"status" IN ('SENT', 'DELIVERED', 'FAILED', 'CANCELLED', 'SEND_UNCERTAIN') AND "variables" <> '{}'::jsonb`,
    rationale:
      'A finished reminder no longer needs the recipient details it was rendered from. The row (status, timing) stays.',
  },
  {
    id: 'AI_TRANSCRIPTS',
    table: 'ai_messages',
    dataClasses: ['D2', 'D4'],
    action: 'delete',
    timestampColumn: 'created_at',
    rationale:
      'AI chat transcript. The conversation row and the patient-facing message history are not affected.',
  },
];

/** Classes / tables the engine must never target, and why — enforced by the spec. */
export const NEVER_AUTO_PURGED: ReadonlyArray<{
  scope: string;
  reason: string;
}> = [
  {
    scope:
      'D3 / D4 patient identity and clinical records (customers, customer_profiles, clinical_*, appointments, customer_notes, customer_files)',
    reason:
      'Retention duty is an unsettled legal question (L12); removed only by an explicit subject deletion.',
  },
  {
    scope:
      'D5 payment and accounting records (invoices, payments, refunds, transactions, settlements)',
    reason: 'Accounting retention is a legal duty of the clinic.',
  },
  {
    scope:
      'D7 audit trails (audit_logs, clinical_access_logs, data_subject_requests, deletion_evidence)',
    reason: 'Accountability evidence must outlive the data it describes.',
  },
];

export interface RetentionPolicyEntry {
  target: RetentionTarget;
  /** Configured age in days; `null` = target is inert. */
  days: number | null;
}

/** Reads each target's setting. Anything but a positive integer leaves the target inert. */
export function resolveRetentionPolicy(
  get: (key: string) => string | number | undefined,
): RetentionPolicyEntry[] {
  return RETENTION_TARGETS.map((target) => {
    const raw = get(settingFor(target));
    const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    return {
      target,
      days:
        raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 1
          ? n
          : null,
    };
  });
}
