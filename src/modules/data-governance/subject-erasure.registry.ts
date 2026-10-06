/**
 * The erasure plan for ONE patient (`customers` row) — residency plan P11/P13.
 *
 * A declarative list of what happens to every table that holds that patient's
 * data. The service executes it; the spec proves it is COMPLETE against the real
 * schema (every table with a foreign key to `customers` must have a step), and a
 * real-Postgres test proves every statement executes and does what it says.
 *
 * ── THREE GROUPS, BECAUSE THE LAW DOES NOT TREAT THEM ALIKE ─────────────────
 *
 *  identity   Always erased or anonymised on a deletion request: the patient's
 *             identity and contact details and the data DERIVED from them (AI
 *             memory, delivery logs, contact entries, action links).
 *
 *  records    Health and clinical content (profile, notes, documents, clinical
 *             entries, appointment notes, chat transcripts). Whether a clinic may
 *             — or must — keep these after a deletion request depends on a
 *             clinical-record retention rule that is NOT settled (plan L12).
 *             So the operator must CHOOSE `retain` or `erase` on every request;
 *             there is no default, and the choice is written to the evidence.
 *
 *  retained   Never erased by this tool: financial and accounting records,
 *             the read-audit trail, and rows that carry no personal data and
 *             only point at the (now anonymised) patient. Each carries a reason.
 *
 * ── WHAT "ANONYMISED" CLAIMS, AND WHAT IT DOES NOT ──────────────────────────
 * The customer row is kept (appointments, invoices and the audit trail point at
 * it) with every identifier overwritten. Records retained against it are
 * de-identified at the row level, not provably anonymous: whether that is
 * enough is a legal question and is stated as such in the evidence.
 *
 * ── PARAMETERS ──────────────────────────────────────────────────────────────
 * Statements use `:tenant`, `:customer`, `:terms` (text[] of LIKE patterns built
 * from the patient's phone / WhatsApp id) and `:emails` (text[], lower-cased).
 * They are compiled to `$n` placeholders — values are never interpolated.
 */

export type ErasureGroup = 'identity' | 'records' | 'retained';
export type ErasureAction = 'delete' | 'scrub' | 'anonymise' | 'retain';

export interface ErasureStep {
  /** Stable id used in evidence and tests. */
  id: string;
  table: string;
  group: ErasureGroup;
  action: ErasureAction;
  /** `SET` clause for scrub / anonymise. */
  set?: string;
  /** `WHERE` clause. Must always be tenant-scoped. */
  where: string;
  /** Required for `retain`: why the rows are kept. */
  reason?: string;
}

/** Subquery fragments reused below. All are tenant-scoped. */
const CUSTOMER_APPOINTMENTS = `SELECT "id" FROM "appointments" WHERE "customerId" = :customer AND "tenantId" = :tenant`;
const CUSTOMER_CONVERSATIONS = `SELECT "id" FROM "conversations" WHERE "tenantId" = :tenant AND "customerId" = :customer`;
const CUSTOMER_MESSAGES = `SELECT "id" FROM "messages" WHERE "tenantId" = :tenant AND ("conversationId" IN (${CUSTOMER_CONVERSATIONS}) OR "senderCustomerId" = :customer)`;
const CUSTOMER_AI_CONVERSATIONS = `SELECT "id" FROM "ai_conversations" WHERE "tenantId" = :tenant AND ("conversationId" IN (${CUSTOMER_CONVERSATIONS}) OR "id" IN (SELECT "ai_conversation_id" FROM "whatsapp_contacts" WHERE "customerId" = :customer AND "tenantId" = :tenant AND "ai_conversation_id" IS NOT NULL))`;

const RECORDS_RETAINED =
  'Health / clinical content. Retention duty is an unsettled legal question (plan L12); the operator chose to retain it. Row is linked only to the anonymised patient.';

export const ERASURE_STEPS: readonly ErasureStep[] = [
  // ── records: health and clinical content (operator chooses) ──────────────
  {
    id: 'ai_messages',
    table: 'ai_messages',
    group: 'records',
    action: 'delete',
    where: `"tenantId" = :tenant AND "ai_conversation_id" IN (SELECT "id"::text FROM (${CUSTOMER_AI_CONVERSATIONS}) c)`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'ai_conversations',
    table: 'ai_conversations',
    group: 'records',
    action: 'scrub',
    set: `"session" = NULL`,
    where: `"id" IN (SELECT "id" FROM (${CUSTOMER_AI_CONVERSATIONS}) c)`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'message_attachments',
    table: 'message_attachments',
    group: 'records',
    action: 'scrub',
    set: `"file_url" = NULL, "file_type" = NULL, "file_name" = NULL, "provider_media_id" = NULL`,
    where: `"tenantId" = :tenant AND "messageId" IN (${CUSTOMER_MESSAGES})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'messages',
    table: 'messages',
    group: 'records',
    action: 'scrub',
    set: `"content" = NULL`,
    where: `"id" IN (${CUSTOMER_MESSAGES})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'handover_requests',
    table: 'handover_requests',
    group: 'records',
    action: 'scrub',
    set: `"reason" = NULL, "notes" = NULL`,
    where: `"tenantId" = :tenant AND "conversationId" IN (${CUSTOMER_CONVERSATIONS})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'conversations',
    table: 'conversations',
    group: 'records',
    action: 'scrub',
    set: `"handover_notes" = NULL, "handover_reason" = NULL`,
    where: `"tenantId" = :tenant AND "customerId" = :customer`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'clinical_entry_revisions',
    table: 'clinical_entry_revisions',
    group: 'records',
    action: 'delete',
    where: `"tenantId" = :tenant AND "entryId" IN (SELECT "id" FROM "clinical_entries" WHERE "customerId" = :customer AND "tenantId" = :tenant)`,
    reason: RECORDS_RETAINED,
  },
  {
    // Rows are kept (the read-audit trail references them); their content is not.
    id: 'clinical_entries',
    table: 'clinical_entries',
    group: 'records',
    action: 'scrub',
    set: `"data" = '{}'::jsonb, "deleted_at" = COALESCE("deleted_at", now())`,
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'clinical_encounters',
    table: 'clinical_encounters',
    group: 'records',
    action: 'scrub',
    set: `"summary" = NULL`,
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'customer_profiles',
    table: 'customer_profiles',
    group: 'records',
    action: 'scrub',
    set: `"medical_history" = NULL, "allergies" = NULL, "blood_type" = NULL, "emergency_contact_name" = NULL, "emergency_contact_phone" = NULL, "notes" = NULL`,
    where: `"customer_id" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'customer_health_fields',
    table: 'customers',
    group: 'records',
    action: 'scrub',
    set: `"chronic_diseases" = NULL, "has_chronic_diseases" = false, "has_health_insurance" = NULL`,
    where: `"id" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'customer_notes',
    table: 'customer_notes',
    group: 'records',
    action: 'delete',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    // The stored objects are purged by the service (every version), then the rows go.
    id: 'customer_files',
    table: 'customer_files',
    group: 'records',
    action: 'delete',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'appointment_notes',
    table: 'appointment_notes',
    group: 'records',
    action: 'delete',
    where: `"tenantId" = :tenant AND "appointmentId" IN (${CUSTOMER_APPOINTMENTS})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'appointments_notes',
    table: 'appointments',
    group: 'records',
    action: 'scrub',
    set: `"notes" = NULL`,
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'appointment_cancellations',
    table: 'appointment_cancellations',
    group: 'records',
    action: 'scrub',
    set: `"reason" = NULL`,
    where: `"tenantId" = :tenant AND "appointmentId" IN (${CUSTOMER_APPOINTMENTS})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'appointment_reschedules',
    table: 'appointment_reschedules',
    group: 'records',
    action: 'scrub',
    set: `"reason" = NULL`,
    where: `"tenantId" = :tenant AND "appointmentId" IN (${CUSTOMER_APPOINTMENTS})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'appointment_history',
    table: 'appointment_history',
    group: 'records',
    action: 'scrub',
    set: `"note" = NULL`,
    where: `"tenantId" = :tenant AND "appointmentId" IN (${CUSTOMER_APPOINTMENTS})`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'customer_reviews',
    table: 'customer_reviews',
    group: 'records',
    action: 'scrub',
    set: `"comment" = NULL, "reply" = NULL`,
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },
  {
    id: 'staff_ratings',
    table: 'staff_ratings',
    group: 'records',
    action: 'scrub',
    set: `"comment" = NULL`,
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason: RECORDS_RETAINED,
  },

  // ── identity: always erased / anonymised ─────────────────────────────────
  {
    id: 'whatsapp_webhooks',
    table: 'whatsapp_webhooks',
    group: 'identity',
    action: 'scrub',
    set: `"payload" = NULL`,
    where: `"tenantId" = :tenant AND "payload" IS NOT NULL AND "payload"::text LIKE ANY(:terms)`,
  },
  {
    id: 'email_logs',
    table: 'email_logs',
    group: 'identity',
    action: 'scrub',
    set: `"to_address" = 'erased@erased.invalid', "subject" = NULL, "metadata" = NULL, "error" = NULL`,
    where: `"tenant_id" = :tenant AND lower("to_address") = ANY(:emails)`,
  },
  {
    id: 'notification_logs',
    table: 'notification_logs',
    group: 'identity',
    action: 'scrub',
    set: `"error_message" = NULL`,
    where: `"tenantId" = :tenant AND "recipient_id" = :customer`,
  },
  {
    // A queued reminder must not be sent after erasure.
    id: 'scheduled_notifications',
    table: 'scheduled_notifications',
    group: 'identity',
    action: 'scrub',
    set: `"variables" = '{}'::jsonb, "failure_reason" = NULL, "status" = CASE WHEN "status" IN ('PENDING', 'SCHEDULED') THEN 'CANCELLED' ELSE "status" END`,
    where: `"tenantId" = :tenant AND "recipient_id" = :customer`,
  },
  {
    id: 'campaign_recipients',
    table: 'campaign_recipients',
    group: 'identity',
    action: 'scrub',
    set: `"email" = NULL, "failure_reason" = NULL`,
    where: `"customerId" = :customer AND "campaignId" IN (SELECT "id" FROM "campaigns" WHERE "tenantId" = :tenant)`,
  },
  {
    // Derived data, not a source record. The embedding sidecar cascades.
    id: 'ai_memories',
    table: 'ai_memories',
    group: 'identity',
    action: 'delete',
    where: `"customer_id" = :customer AND "tenantId" = :tenant`,
  },
  {
    id: 'workflow_runs',
    table: 'workflow_runs',
    group: 'identity',
    action: 'scrub',
    set: `"context" = NULL, "results" = NULL`,
    where: `"tenantId" = :tenant AND (COALESCE("context"::text, '') LIKE '%' || (:customer)::text || '%' OR COALESCE("results"::text, '') LIKE '%' || (:customer)::text || '%')`,
  },
  {
    id: 'patient_action_links',
    table: 'patient_action_links',
    group: 'identity',
    action: 'delete',
    where: `"tenantId" = :tenant AND "appointmentId" IN (${CUSTOMER_APPOINTMENTS})`,
  },
  {
    id: 'whatsapp_contacts',
    table: 'whatsapp_contacts',
    group: 'identity',
    action: 'delete',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
  },
  {
    id: 'customer_tag_relations',
    table: 'customer_tag_relations',
    group: 'identity',
    action: 'delete',
    where: `"customerId" = :customer`,
  },
  {
    id: 'customer_addresses',
    table: 'customer_addresses',
    group: 'identity',
    action: 'delete',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
  },
  {
    // LAST: everything above locates rows through this customer.
    id: 'customers',
    table: 'customers',
    group: 'identity',
    action: 'anonymise',
    set:
      `"full_name" = 'Erased patient', "phone" = 'ERASED', "whatsapp_id" = NULL, "whatsapp_name" = NULL, ` +
      `"email" = 'erased-' || "id"::text || '@erased.invalid', "gender" = NULL, "date_of_birth" = NULL, ` +
      `"national_id" = NULL, "source" = NULL, "marketing_opt_in" = false, ` +
      `"opted_out_at" = COALESCE("opted_out_at", now()), "opt_out_source" = COALESCE("opt_out_source", 'erasure'), ` +
      `"preferred_locale" = NULL, "is_active" = false, "deleted_at" = COALESCE("deleted_at", now()), "updated_at" = now()`,
    where: `"id" = :customer AND "tenantId" = :tenant`,
  },

  // ── retained: never erased by this tool ──────────────────────────────────
  {
    id: 'invoices',
    table: 'invoices',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Accounting / tax record. Retention is a legal duty of the clinic; amounts and numbers only, linked to the anonymised patient.',
  },
  {
    id: 'payments',
    table: 'payments',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Payment record kept for accounting, refunds and disputes. Payment-provider ids and amounts; no card number is stored.',
  },
  {
    id: 'appointments',
    table: 'appointments',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Visit record (date, status, amount) kept for scheduling integrity and accounting; free-text notes are handled under `records`.',
  },
  {
    id: 'waitlist_entries',
    table: 'waitlist_entries',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Carries no personal data (ids and times); points only at the anonymised patient.',
  },
  {
    id: 'queue_entries',
    table: 'queue_entries',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Carries no personal data (ids and times); points only at the anonymised patient.',
  },
  {
    id: 'data_subject_requests',
    table: 'data_subject_requests',
    group: 'retained',
    action: 'retain',
    where: `"tenant_id" = :tenant AND "customer_id" = :customer`,
    reason:
      'Accountability record of the request itself (type, dates, outcome counts). Ids only; it is the proof the request was handled.',
  },
  {
    id: 'clinical_access_logs',
    table: 'clinical_access_logs',
    group: 'retained',
    action: 'retain',
    where: `"customerId" = :customer AND "tenantId" = :tenant`,
    reason:
      'Read-audit trail (who read which record, when). Accountability evidence; holds ids only.',
  },
];

/**
 * Places that may hold this patient's data and that this tool CANNOT reach by
 * customer id. Reported in every evidence record so a deletion is never read as
 * more complete than it is.
 */
export const KNOWN_GAPS: ReadonlyArray<{ target: string; reason: string }> = [
  {
    target: 'database backups and point-in-time recovery',
    reason:
      'Erased rows persist in backups until the backup retention window passes (14 days planned). Backups are not edited.',
  },
  {
    target: 'queue payloads in Redis (queued or failed jobs)',
    reason:
      'Email / WhatsApp / AI jobs not yet completed hold recipient data until they finish or expire (failed PII jobs: 6 h).',
  },
  {
    target: 'application logs and CloudWatch',
    reason:
      'Logs are scrubbed at write time; retained logs age out under the log retention period.',
  },
  {
    target:
      'integration_inbound_events / integration_import_items / integration_conflicts',
    reason:
      'Partner payloads are not keyed by customer id; they are cleared with the integration connection.',
  },
  {
    target: 'export_jobs and generated export files',
    reason:
      'A report export may contain this patient; files expire under the export expiry.',
  },
  {
    target: 'webhook_deliveries / outbox_jobs / analytics_events payloads',
    reason:
      'Telemetry payloads are not keyed by customer id; they age out under their retention.',
  },
  {
    target: 'support_tickets',
    reason:
      'Free text a staff member typed about a patient is not searchable by customer id.',
  },
  {
    target: 'processor-side copies (OpenAI, Meta, Tap, email provider)',
    reason:
      'Copies held by third parties are outside this system; a deletion request to each processor is a separate, manual step (see the subprocessor register).',
  },
];

export interface CompiledStatement {
  text: string;
  params: unknown[];
}

export interface ErasureParams {
  tenant: string;
  customer: string;
  terms: string[];
  emails: string[];
}

/** Replaces `:name` placeholders with `$n`, reusing a number for a repeated name. */
export function compileStatement(
  sql: string,
  values: ErasureParams,
): CompiledStatement {
  const order: Array<keyof ErasureParams> = [];
  const text = sql.replace(
    /:(tenant|customer|terms|emails)\b/g,
    (_m, name: keyof ErasureParams) => {
      let idx = order.indexOf(name);
      if (idx === -1) {
        order.push(name);
        idx = order.length - 1;
      }
      return `$${idx + 1}`;
    },
  );
  return { text, params: order.map((n) => values[n]) };
}

export function statementFor(
  step: ErasureStep,
  values: ErasureParams,
): CompiledStatement {
  switch (step.action) {
    case 'delete':
      return compileStatement(
        `DELETE FROM "${step.table}" WHERE ${step.where}`,
        values,
      );
    case 'scrub':
    case 'anonymise':
      return compileStatement(
        `UPDATE "${step.table}" SET ${step.set} WHERE ${step.where}`,
        values,
      );
    case 'retain':
      return compileStatement(
        `SELECT count(*)::int AS n FROM "${step.table}" WHERE ${step.where}`,
        values,
      );
  }
}

/** The statement that counts what a step would touch, used to report retained rows. */
export function countStatementFor(
  step: ErasureStep,
  values: ErasureParams,
): CompiledStatement {
  return compileStatement(
    `SELECT count(*)::int AS n FROM "${step.table}" WHERE ${step.where}`,
    values,
  );
}
