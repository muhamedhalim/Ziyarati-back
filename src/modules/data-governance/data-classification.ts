/**
 * Data classification registry (residency plan P16 / section 5).
 *
 * One row per database table: which of the plan's data classes it holds, whose
 * data it is, and why it exists. It is METADATA ONLY — no schema change, no
 * runtime behaviour depends on it — and it is the input to the DPIA inventory
 * (`dpia-inventory.ts`) and to the erasure / retention completeness checks.
 *
 * `data-classification.spec.ts` builds the real TypeORM entity metadata and
 * fails when a table has no row here (a new entity must be classified) or a row
 * names a table that no longer exists.
 *
 * Classes (plan section 5). A table lists EVERY class it can hold, strictest
 * relevant first; it is classified by what it CAN contain, not by what a typical
 * row does:
 *   D0 public · D1 internal / infrastructure · D2 personal · D3 sensitive
 *   identifiers (national ID, insurance no.) · D4 health · D5 payment ·
 *   D6 authentication / secrets · D7 audit · D8 operational telemetry (treated
 *   as D2/D4 until its payload is verified clean).
 *
 * This is a technical inventory, not a legal determination: a classification
 * here does not decide what the law permits, only what controls apply.
 */

export type DataClass =
  | 'D0'
  | 'D1'
  | 'D2'
  | 'D3'
  | 'D4'
  | 'D5'
  | 'D6'
  | 'D7'
  | 'D8';
export type DataSubject = 'patient' | 'staff' | 'clinic' | 'platform';

export interface TableClassification {
  table: string;
  classes: DataClass[];
  /** Whose personal data the table can hold. Empty for D0/D1 tables. */
  subjects: DataSubject[];
  purpose: string;
}

type Row = [table: string, classes: string, subjects: string, purpose: string];

const P = 'patient';
const S = 'staff';
const C = 'clinic';

// prettier-ignore
const ROWS: Row[] = [
  // ── AI ──────────────────────────────────────────────────────────────────
  ['ai_agents', 'D1', '', 'AI agent configuration per tenant'],
  ['ai_batch_items', 'D2,D4', P, 'Items of an OpenAI batch job; carry conversation content'],
  ['ai_batch_jobs', 'D1', '', 'OpenAI batch job bookkeeping'],
  ['ai_conversations', 'D2,D4', P, 'AI chat sessions; session JSON holds booking state (names, phones)'],
  ['ai_cost_logs', 'D1', '', 'AI spend accounting'],
  ['ai_execution_metrics', 'D1', '', 'AI latency and outcome metrics'],
  ['ai_knowledge_bases', 'D1', '', 'Clinic-authored knowledge for retrieval'],
  ['ai_memories', 'D2,D4', P, 'Long-term per-patient AI memory; embeddings sit in a sidecar that cascades'],
  ['ai_messages', 'D2,D4', P, 'AI chat transcript'],
  ['ai_prompts', 'D1', '', 'Tenant prompt configuration'],
  ['ai_training_files', 'D1', '', 'Clinic knowledge uploads'],
  ['ai_usage_logs', 'D1', '', 'AI token usage'],
  ['tenant_ai_deployments', 'D6', '', 'Per-tenant AI route with an encrypted provider key'],
  // ── Analytics / reporting ───────────────────────────────────────────────
  ['analytics_events', 'D8', '', 'Product analytics events'],
  ['daily_reports', 'D1', '', 'Aggregated daily report'],
  ['monthly_reports', 'D1', '', 'Aggregated monthly report'],
  ['dashboard_metrics', 'D1', '', 'Aggregated dashboard counters'],
  ['export_jobs', 'D2,D4', P, 'Report export jobs; the produced file can hold patient rows'],
  ['usage_report_schedules', 'D2', S, 'Scheduled usage report recipients'],
  // ── Appointments / scheduling / queue ───────────────────────────────────
  ['appointments', 'D2,D4', P, 'Bookings; the service and notes can reveal a condition'],
  ['appointment_services', 'D2', P, 'Services on a booking'],
  ['appointment_cancellations', 'D2,D4', P, 'Cancellation record; reason is free text'],
  ['appointment_history', 'D2', P, 'Booking change history'],
  ['appointment_notes', 'D4', P, 'Staff free-text notes on a booking'],
  ['appointment_reschedules', 'D2', P, 'Reschedule record'],
  ['appointment_status_logs', 'D2', P, 'Booking status transitions'],
  ['blocked_slots', 'D1', '', 'Blocked calendar time'],
  ['calendar_slots', 'D1', '', 'Calendar slots'],
  ['holidays', 'D1', '', 'Clinic holidays'],
  ['waitlist_entries', 'D2', P, 'Waitlist'],
  ['waitlist_offers', 'D2', P, 'Waitlist offers'],
  ['queue_entries', 'D2', P, 'Walk-in queue'],
  ['patient_action_links', 'D6', P, 'Hashed single-use patient action tokens'],
  // ── Auth / RBAC ─────────────────────────────────────────────────────────
  ['users', 'D2,D6', S, 'Staff accounts and password hashes'],
  ['patients', 'D2,D6', P, 'Patient accounts (marketplace) and password hashes'],
  ['roles', 'D1', '', 'Roles'],
  ['permissions', 'D1', '', 'Permission catalogue'],
  ['role_permissions', 'D1', '', 'Role to permission mapping'],
  ['user_roles', 'D1', '', 'User to role mapping'],
  ['refresh_tokens', 'D6', S, 'Hashed refresh tokens'],
  ['password_resets', 'D6', S, 'Hashed password-reset tokens'],
  ['user_mfa', 'D6', S, 'Encrypted TOTP seed and lockout state for staff MFA'],
  ['user_mfa_recovery_codes', 'D6', S, 'Hashed single-use MFA recovery codes'],
  ['api_keys', 'D6', C, 'Hashed integration API keys'],
  ['api_logs', 'D8', S, 'API request log; stores client IP'],
  // ── Audit ───────────────────────────────────────────────────────────────
  ['data_subject_requests', 'D7', 'patient,staff', 'Data-subject request trail: ids, type, status, counts (no personal data in the row)'],
  ['deletion_evidence', 'D7', '', 'Append-only proof of what a deletion touched (no personal data in the row)'],
  ['audit_logs', 'D7', S, 'Clinic activity log'],
  ['clinical_access_logs', 'D7', 'patient,staff', 'Who read which patient record (read-audit)'],
  ['verification_audit_logs', 'D7', S, 'Clinic verification audit'],
  // ── Billing / payments (D5) ─────────────────────────────────────────────
  ['billing_upgrade_requests', 'D5', C, 'Plan upgrade requests'],
  ['billing_upgrade_request_events', 'D5', C, 'Upgrade request events'],
  ['invoices', 'D5', P, 'Patient invoices'],
  ['invoice_items', 'D5', P, 'Invoice lines'],
  ['payments', 'D2,D5', P, 'Patient payments; metadata and failure text can hold payer details'],
  ['payment_links', 'D5,D6', P, 'Payment link tokens'],
  ['payment_reconciliation_exceptions', 'D5', '', 'Reconciliation discrepancies'],
  ['merchant_accounts', 'D5', C, 'Clinic merchant accounts at the payment provider'],
  ['refunds', 'D5', P, 'Refunds'],
  ['transactions', 'D5', P, 'Ledger transactions'],
  ['settlements', 'D5', C, 'Payout settlements'],
  ['settlement_items', 'D5', C, 'Settlement lines'],
  ['resource_purchases', 'D5', C, 'Add-on purchases'],
  ['subscriptions', 'D5', C, 'Clinic subscriptions'],
  ['subscription_invoices', 'D5', C, 'Clinic subscription invoices'],
  ['subscription_plans', 'D1', '', 'Plan catalogue'],
  ['subscription_usage', 'D1', '', 'Plan usage counters'],
  ['tenant_payment_methods', 'D5', C, 'Tokenised clinic payment methods (brand, scheme, last four only)'],
  ['tenant_usage_limit_overrides', 'D1', '', 'Per-tenant limit overrides'],
  ['resource_price_catalog', 'D1', '', 'Add-on price catalogue'],
  ['resource_price_change_events', 'D1', '', 'Price catalogue history'],
  ['staff_commissions', 'D5', S, 'Staff commission accounting'],
  // ── Campaigns / notifications / messaging ───────────────────────────────
  ['campaigns', 'D1', '', 'Campaign definitions'],
  ['campaign_runs', 'D1', '', 'Campaign runs'],
  ['campaign_recipients', 'D2', P, 'Per-recipient campaign delivery; email and failure text'],
  ['outbox_jobs', 'D8', '', 'Outbox of side-effects to dispatch'],
  ['notification_logs', 'D2,D8', P, 'WhatsApp / notification delivery log'],
  ['notification_preferences', 'D2', 'patient,staff', 'Channel preferences'],
  ['notification_rules', 'D1', '', 'Notification rules'],
  ['notification_templates', 'D1', '', 'Notification templates'],
  ['scheduled_notifications', 'D2', P, 'Queued reminders; variables hold recipient details'],
  ['in_app_notifications', 'D2', S, 'Staff inbox'],
  ['admin_notifications', 'D1', '', 'Platform operator notices'],
  ['email_logs', 'D2,D8', P, 'Email delivery log; metadata stores the template variables'],
  ['email_suppressions', 'D2', P, 'Suppressed email addresses'],
  ['conversations', 'D2,D4', P, 'Patient conversation threads'],
  ['conversation_participants', 'D2', 'patient,staff', 'Thread participants'],
  ['messages', 'D2,D4', P, 'Conversation messages'],
  ['message_attachments', 'D4', P, 'Message attachments'],
  ['message_status_logs', 'D8', '', 'Message delivery status'],
  ['handover_requests', 'D2', P, 'AI to human handover requests'],
  ['whatsapp_accounts', 'D6', C, 'WhatsApp Business account tokens'],
  ['whatsapp_contacts', 'D2', P, 'WhatsApp contacts'],
  ['whatsapp_templates', 'D1', '', 'WhatsApp message templates'],
  ['whatsapp_webhooks', 'D2,D8', P, 'Raw inbound WhatsApp webhook events'],
  // ── CRM / patient record ────────────────────────────────────────────────
  ['customers', 'D2,D3,D4', P, 'The patient record: identity, contact, national ID, chronic-disease intake'],
  ['customer_addresses', 'D2', P, 'Patient addresses'],
  ['customer_profiles', 'D4', P, 'Medical history, allergies, blood type, emergency contact'],
  ['customer_notes', 'D4', P, 'Staff notes on a patient'],
  ['customer_files', 'D4', P, 'Patient documents (objects in storage)'],
  ['customer_reviews', 'D2', P, 'Patient reviews'],
  ['customer_segments', 'D1', '', 'Segment definitions'],
  ['customer_tag_relations', 'D2', P, 'Tags applied to a patient'],
  ['customer_tags', 'D1', '', 'Tag definitions'],
  ['clinical_encounters', 'D4', P, 'Clinical encounters'],
  ['clinical_entries', 'D4', P, 'Clinical entries (diagnosis, prescription, results, ...)'],
  ['clinical_entry_revisions', 'D4', P, 'Clinical entry revision history'],
  ['file_uploads', 'D4', 'patient,staff', 'Uploaded file metadata'],
  ['staff_ratings', 'D2', P, 'Patient ratings of staff; comment is free text'],
  // ── Integrations / webhooks ─────────────────────────────────────────────
  ['integration_connections', 'D6', C, 'Encrypted connections to a clinic PMS'],
  ['integration_conflicts', 'D2', P, 'Sync conflicts between systems'],
  ['integration_id_map', 'D2', P, 'External id mapping'],
  ['integration_idempotency_keys', 'D1', '', 'Idempotency keys'],
  ['integration_import_items', 'D2', P, 'Excel import rows'],
  ['integration_import_jobs', 'D2', P, 'Excel import jobs'],
  ['integration_inbound_events', 'D2', P, 'Inbound partner events'],
  ['integration_oauth_states', 'D6', C, 'OAuth state values'],
  ['integration_staff_provisioning', 'D2', S, 'Staff provisioning from a PMS'],
  ['integration_sync_jobs', 'D1', '', 'Sync job bookkeeping'],
  ['integration_webhook_endpoints', 'D6', C, 'Inbound partner endpoints and secrets'],
  ['webhook_endpoints', 'D6', C, 'Outbound webhook endpoints and secrets'],
  ['webhook_deliveries', 'D2,D8', P, 'Outbound webhook delivery payloads'],
  ['webhook_logs', 'D8', '', 'Webhook log'],
  // ── Services / staff / branches / tenant ────────────────────────────────
  ['services', 'D1', '', 'Clinic service catalogue'],
  ['service_categories', 'D1', '', 'Service categories'],
  ['service_prices', 'D1', '', 'Service prices'],
  ['service_resources', 'D1', '', 'Service resources'],
  ['specialties', 'D0', '', 'Specialty lookup'],
  ['staff_profiles', 'D2', S, 'Staff profiles'],
  ['staff_schedules', 'D1', '', 'Staff schedules'],
  ['staff_services', 'D1', '', 'Staff to service mapping'],
  ['staff_specialties', 'D1', '', 'Staff to specialty mapping'],
  ['staff_time_off', 'D2', S, 'Staff time off'],
  ['working_hours', 'D1', '', 'Working hours'],
  ['branches', 'D1', '', 'Clinic branches'],
  ['branch_users', 'D2', S, 'Staff to branch assignment'],
  ['tenants', 'D1,D2', C, 'Clinic account and contact details'],
  ['tenant_settings', 'D1', '', 'Clinic settings'],
  ['tenant_specialties', 'D1', '', 'Clinic specialties'],
  ['tenant_targets', 'D1', '', 'Monthly clinic / branch appointment and revenue goals (numeric, no personal data)'],
  ['tenant_target_history', 'D1,D2', S, 'Append-only ledger of target changes; stores the acting staff user id'],
  ['tenant_approval_events', 'D1', '', 'Clinic approval history'],
  ['tenant_verification_documents', 'D2', C, 'Clinic licence documents'],
  // ── Platform / support / sales ──────────────────────────────────────────
  ['feature_definitions', 'D1', '', 'Feature catalogue'],
  ['feature_dependencies', 'D1', '', 'Feature dependencies'],
  ['feature_flags', 'D1', '', 'Per-tenant feature flags'],
  ['feature_plans', 'D1', '', 'Feature to plan mapping'],
  ['system_settings', 'D1,D6', '', 'Platform settings; may hold secrets'],
  ['support_tickets', 'D2', 'staff,patient', 'Support tickets; free text can mention a patient'],
  ['contact_leads', 'D2', C, 'Website Contact Us enquiries from prospective clinics (name, email, phone, facility, free-text message); no tenant yet'],
  ['support_ticket_events', 'D2', 'staff,patient', 'Support ticket events'],
  ['sales_activities', 'D2', S, 'Sales staff activity'],
  ['sales_bonus_records', 'D5', S, 'Sales bonus accounting'],
  ['sales_clinic_assignments', 'D1', '', 'Sales assignment'],
  ['sales_target_revisions', 'D1', '', 'Sales target history'],
  ['sales_targets', 'D1', '', 'Sales targets'],
  ['workflows', 'D1', '', 'Workflow definitions'],
  ['workflow_runs', 'D2', P, 'Workflow runs; context carries the triggering record'],
  // ── Lookups ─────────────────────────────────────────────────────────────
  ['cities', 'D0', '', 'City lookup'],
  ['countries', 'D0', '', 'Country lookup'],
  ['currencies', 'D0', '', 'Currency lookup'],
  ['languages', 'D0', '', 'Language lookup'],
  ['timezones', 'D0', '', 'Timezone lookup'],
];

const SUBJECTS = new Set<string>(['patient', 'staff', 'clinic', 'platform']);
const CLASSES = new Set<string>([
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'D8',
]);

function parse(row: Row): TableClassification {
  const [table, classes, subjects, purpose] = row;
  const cls = classes.split(',').map((c) => c.trim());
  const subj = subjects
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of cls)
    if (!CLASSES.has(c))
      throw new Error(`data-classification: bad class "${c}" for ${table}`);
  for (const s of subj)
    if (!SUBJECTS.has(s))
      throw new Error(`data-classification: bad subject "${s}" for ${table}`);
  return {
    table,
    classes: cls as DataClass[],
    subjects: subj as DataSubject[],
    purpose,
  };
}

export const DATA_CLASSIFICATION: readonly TableClassification[] =
  ROWS.map(parse);

const BY_TABLE = new Map(DATA_CLASSIFICATION.map((c) => [c.table, c]));

export function classifyTable(table: string): TableClassification | undefined {
  return BY_TABLE.get(table);
}

/** Tables that can hold any of the given classes. */
export function tablesHolding(...classes: DataClass[]): string[] {
  return DATA_CLASSIFICATION.filter((c) =>
    c.classes.some((k) => classes.includes(k)),
  ).map((c) => c.table);
}

/** The classes that must NEVER reach AI / WhatsApp / email unminimised (plan section 5). */
export const NEVER_EXTERNAL_BY_DEFAULT: readonly DataClass[] = [
  'D3',
  'D4',
  'D6',
];
