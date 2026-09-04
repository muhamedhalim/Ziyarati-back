-- ===========================================================================
-- P0.2_PRODUCTION_VERIFICATION.sql
--
-- Proves whether PostgreSQL is CURRENTLY ENFORCING each critical integrity
-- guard.
--
-- SAFETY: reads only pg_catalog and information_schema. It writes NOTHING to
-- any user table and takes no locks beyond ordinary catalog access. It does
-- create two TEMPORARY VIEWs (pg_temp, session-local) to hold the expected
-- values — these live only for the duration of the psql session, are invisible
-- to every other connection, and vanish on disconnect. If your policy forbids
-- even temp objects on production, run this against a read replica.
-- There is no INSERT/UPDATE/DELETE and no persistent DDL anywhere in it.
--
--   psql "$DATABASE_URL" -f P0.2_PRODUCTION_VERIFICATION.sql
--
-- WHY THIS EXISTS: the `migrations` table is NOT evidence. P0.1 proved a
-- migration can be recorded as applied while its object is absent, and P0.2
-- proved that a single TYPEORM_SYNCHRONIZE=true boot removes 32 integrity
-- objects from a fully-migrated schema. Only pg_catalog is authoritative.
--
-- VERDICTS (per object)
--   PASS       present, and its definition matches the canonical one exactly
--   FAIL       ABSENT — PostgreSQL is NOT enforcing this rule
--   MISMATCH   present but the definition DIFFERS from canonical (read it)
--   UNKNOWN    the underlying table does not exist in this database
--
-- Expected definitions are captured from a database built by running the full
-- migration chain from empty (133 migrations) plus the application bootstraps,
-- on PostgreSQL 18. On a different major version pg_get_constraintdef /
-- pg_indexes may format identically-meaning SQL differently — a MISMATCH is a
-- prompt to read the two strings, not proof of a defect.
-- ===========================================================================
\pset pager off

\echo ''
\echo '=== TARGET ================================================================'
SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       now() AS checked_at;

CREATE TEMP VIEW p02_expected(severity, obj_name, obj_kind, purpose, expected_def) AS
VALUES
    ('P0', 'appointments_no_overlap', 'constraint', 'double-booking guard (the only race-safe one)', 'EXCLUDE USING gist ("staffId" WITH =, tstzrange(start_at, end_at, ''[)''::text) WITH &&) WHERE (((status <> ALL (ARRAY[''CANCELLED''::appointments_status_enum, ''NO_SHOW''::appointments_status_enum])) AND (deleted_at IS NULL)))'),
    ('P0', 'uq_refund_idem', 'index', 'refund idempotency — duplicate refunds if lost', 'CREATE UNIQUE INDEX uq_refund_idem ON public.refunds USING btree ("tenantId", idempotency_key) WHERE (idempotency_key IS NOT NULL)'),
    ('P0', 'uq_refund_gateway_id', 'index', 'refund gateway id uniqueness', 'CREATE UNIQUE INDEX uq_refund_gateway_id ON public.refunds USING btree (gateway_refund_id) WHERE (gateway_refund_id IS NOT NULL)'),
    ('P0', 'uq_txn_webhook_event', 'index', 'payment webhook dedup — double-credit if lost', 'CREATE UNIQUE INDEX uq_txn_webhook_event ON public.transactions USING btree (gateway_transaction_id) WHERE (((type)::text = ''webhook''::text) AND (gateway_transaction_id IS NOT NULL))'),
    ('P0', 'uq_payments_appointment_pending', 'index', 'one pending payment per appointment', 'CREATE UNIQUE INDEX uq_payments_appointment_pending ON public.payments USING btree ("appointmentId") WHERE ((status = ''PENDING''::payments_status_enum) AND ("appointmentId" IS NOT NULL))'),
    ('P0', 'uq_settlement_adj_refund', 'index', 'settlement adjustment dedup', 'CREATE UNIQUE INDEX uq_settlement_adj_refund ON public.settlement_adjustments USING btree (refund_id) WHERE (refund_id IS NOT NULL)'),
    ('P0', 'UQ_resource_purchases_tenant_idempotency', 'index', 'resource purchase idempotency (charges money)', 'CREATE UNIQUE INDEX "UQ_resource_purchases_tenant_idempotency" ON public.resource_purchases USING btree ("tenantId", idempotency_key)'),
    ('P0', 'UQ_sub_invoice_webhook_event', 'index', 'billing webhook dedup', 'CREATE UNIQUE INDEX "UQ_sub_invoice_webhook_event" ON public.subscription_invoices USING btree (webhook_event_id) WHERE (webhook_event_id IS NOT NULL)'),
    ('P0', 'UQ_sub_invoice_period', 'index', 'one non-void invoice per period', 'CREATE UNIQUE INDEX "UQ_sub_invoice_period" ON public.subscription_invoices USING btree (subscription_id, period_start) WHERE (status <> ''VOID''::subscription_invoices_status_enum)'),
    ('P0', 'UQ_tenant_entitlement_ledger_source_purchase', 'index', 'entitlement ledger purchase dedup', 'CREATE UNIQUE INDEX "UQ_tenant_entitlement_ledger_source_purchase" ON public.tenant_entitlement_ledger USING btree ("sourcePurchaseId") WHERE (("sourcePurchaseId" IS NOT NULL) AND ((direction)::text = ''grant''::text))'),
    ('P0', 'UQ_tenant_entitlement_ledger_source_refund', 'index', 'entitlement ledger refund dedup', 'CREATE UNIQUE INDEX "UQ_tenant_entitlement_ledger_source_refund" ON public.tenant_entitlement_ledger USING btree ("sourceRefundId") WHERE ("sourceRefundId" IS NOT NULL)'),
    ('P0', 'UQ_integration_inbound_events_replay', 'index', 'inbound webhook replay protection', 'CREATE UNIQUE INDEX "UQ_integration_inbound_events_replay" ON public.integration_inbound_events USING btree ("tenantId", "endpointId", provider_event_id)'),
    ('P0', 'uq_message_wa_id', 'index', 'WhatsApp message dedup', 'CREATE UNIQUE INDEX uq_message_wa_id ON public.messages USING btree ("tenantId", wa_message_id) WHERE (wa_message_id IS NOT NULL)'),
    ('P0', 'uq_message_status', 'index', 'WhatsApp status-callback dedup', 'CREATE UNIQUE INDEX uq_message_status ON public.message_status_logs USING btree ("messageId", status)'),
    ('P0', 'UQ_integration_oauth_states_state', 'index', 'OAuth state replay protection', 'CREATE UNIQUE INDEX "UQ_integration_oauth_states_state" ON public.integration_oauth_states USING btree (state)'),
    ('P0', 'uq_ai_tool_call_idem', 'index', 'AI tool-call idempotency', 'CREATE UNIQUE INDEX uq_ai_tool_call_idem ON public.ai_tool_calls USING btree (tenant_id, idempotency_key)'),
    ('P0', 'uq_user_email_global', 'index', 'global unique login email', 'CREATE UNIQUE INDEX uq_user_email_global ON public.users USING btree (email) WHERE ((deleted_at IS NULL) AND (email IS NOT NULL))'),
    ('P0', 'ck_user_email_lowercase', 'constraint', 'email normalisation (pairs with the above)', 'CHECK (((email IS NULL) OR ((email)::text = lower((email)::text))))'),
    ('P1', 'UQ_customers_tenant_email', 'index', 'one customer per tenant email', 'CREATE UNIQUE INDEX "UQ_customers_tenant_email" ON public.customers USING btree ("tenantId", email) WHERE (deleted_at IS NULL)'),
    ('P1', 'UQ_customers_tenant_national_id', 'index', 'one customer per tenant national id', 'CREATE UNIQUE INDEX "UQ_customers_tenant_national_id" ON public.customers USING btree ("tenantId", national_id) WHERE ((national_id IS NOT NULL) AND (deleted_at IS NULL))'),
    ('P1', 'UQ_email_suppressions_tenant_email', 'index', 'unsubscribe suppression (compliance)', 'CREATE UNIQUE INDEX "UQ_email_suppressions_tenant_email" ON public.email_suppressions USING btree (tenant_id, email)'),
    ('P1', 'UQ_email_logs_idempotency', 'index', 'outbound email idempotency', 'CREATE UNIQUE INDEX "UQ_email_logs_idempotency" ON public.email_logs USING btree (idempotency_key)'),
    ('P1', 'UQ_notification_logs_source_ref', 'index', 'notification dedup', 'CREATE UNIQUE INDEX "UQ_notification_logs_source_ref" ON public.notification_logs USING btree (source_ref) WHERE (source_ref IS NOT NULL)'),
    ('P1', 'UQ_scheduled_notifications_source_ref', 'index', 'scheduled notification dedup', 'CREATE UNIQUE INDEX "UQ_scheduled_notifications_source_ref" ON public.scheduled_notifications USING btree (source_ref) WHERE (source_ref IS NOT NULL)'),
    ('P1', 'UQ_scheduled_notifications_provider_ref', 'index', 'provider ref dedup', 'CREATE UNIQUE INDEX "UQ_scheduled_notifications_provider_ref" ON public.scheduled_notifications USING btree (provider_ref) WHERE (provider_ref IS NOT NULL)'),
    ('P1', 'UQ_campaign_recipients_provider_ref', 'index', 'campaign provider ref dedup', 'CREATE UNIQUE INDEX "UQ_campaign_recipients_provider_ref" ON public.campaign_recipients USING btree (provider_ref) WHERE (provider_ref IS NOT NULL)'),
    ('P1', 'uq_recipient_run_customer', 'index', 'one campaign recipient per run', 'CREATE UNIQUE INDEX uq_recipient_run_customer ON public.campaign_recipients USING btree ("runId", "customerId")'),
    ('P1', 'UQ_in_app_notifications_recipient_dedupe', 'index', 'in-app notification dedup', 'CREATE UNIQUE INDEX "UQ_in_app_notifications_recipient_dedupe" ON public.in_app_notifications USING btree (recipient_user_id, dedupe_key) WHERE (dedupe_key IS NOT NULL)'),
    ('P1', 'UQ_subscription_usage_tenant_period_unsubscribed', 'index', 'one usage row per tenant period', 'CREATE UNIQUE INDEX "UQ_subscription_usage_tenant_period_unsubscribed" ON public.subscription_usage USING btree (tenant_id, period_month) WHERE (subscription_id IS NULL)'),
    ('P1', 'uq_dashboard_metric', 'index', 'dashboard metric dedup', 'CREATE UNIQUE INDEX uq_dashboard_metric ON public.dashboard_metrics USING btree ("tenantId", metric_key, period)'),
    ('P1', 'UQ_integration_id_map_external', 'index', 'sync identity map (external)', 'CREATE UNIQUE INDEX "UQ_integration_id_map_external" ON public.integration_id_map USING btree ("tenantId", "connectionId", resource_type, external_id) WHERE (unlinked_at IS NULL)'),
    ('P1', 'UQ_integration_id_map_internal', 'index', 'sync identity map (internal)', 'CREATE UNIQUE INDEX "UQ_integration_id_map_internal" ON public.integration_id_map USING btree ("tenantId", "connectionId", resource_type, internal_resource_id) WHERE (unlinked_at IS NULL)'),
    ('P1', 'UQ_integration_conflicts_open', 'index', 'one open conflict per resource', 'CREATE UNIQUE INDEX "UQ_integration_conflicts_open" ON public.integration_conflicts USING btree ("tenantId", "connectionId", resource_type, external_id) WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''resolving''::character varying, ''stale''::character varying])::text[]))'),
    ('P1', 'UQ_integration_sync_active', 'index', 'one active sync per resource', 'CREATE UNIQUE INDEX "UQ_integration_sync_active" ON public.integration_sync_jobs USING btree ("tenantId", "connectionId", resource_type, direction) WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''running''::character varying])::text[]))'),
    ('P1', 'UQ_integration_staff_provisioning_open', 'index', 'one open provisioning per staff', 'CREATE UNIQUE INDEX "UQ_integration_staff_provisioning_open" ON public.integration_staff_provisioning USING btree ("tenantId", "connectionId", external_id) WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''ambiguous''::character varying])::text[]))'),
    ('P1', 'UQ_integration_webhook_endpoints_connection', 'index', 'one webhook endpoint per connection', 'CREATE UNIQUE INDEX "UQ_integration_webhook_endpoints_connection" ON public.integration_webhook_endpoints USING btree ("connectionId")'),
    ('P1', 'UQ_billing_upgrade_requests_active_target', 'index', 'one active upgrade request per target', 'CREATE UNIQUE INDEX "UQ_billing_upgrade_requests_active_target" ON public.billing_upgrade_requests USING btree ("tenantId", COALESCE(feature_key, usage_metric)) WHERE ((status)::text = ANY ((ARRAY[''pending_review''::character varying, ''awaiting_owner_approval''::character varying, ''payment_processing''::character varying, ''payment_failed''::character varying])::text[]))'),
    ('P1', 'UQ_tenant_usage_limit_overrides_active', 'index', 'one active override per limit', 'CREATE UNIQUE INDEX "UQ_tenant_usage_limit_overrides_active" ON public.tenant_usage_limit_overrides USING btree ("tenantId", metric) WHERE (is_active = true)'),
    ('P1', 'UQ_feature_definitions_key', 'index', 'feature key uniqueness', 'CREATE UNIQUE INDEX "UQ_feature_definitions_key" ON public.feature_definitions USING btree (feature_key)'),
    ('P1', 'UQ_support_tickets_ticket_number', 'constraint', 'ticket number uniqueness', 'UNIQUE (ticket_number)'),
    ('P1', 'UQ_customer_segments_tenant_name_live', 'index', 'segment name uniqueness', 'CREATE UNIQUE INDEX "UQ_customer_segments_tenant_name_live" ON public.customer_segments USING btree ("tenantId", name) WHERE (deleted_at IS NULL)'),
    ('P1', 'uq_ai_kb_source_content_hash', 'index', 'knowledge-base content dedup', 'CREATE UNIQUE INDEX uq_ai_kb_source_content_hash ON public.ai_knowledge_bases USING btree ("tenantId", "agentId", COALESCE(source_id, ''00000000-0000-0000-0000-000000000000''::uuid), content_hash)'),
    ('P1', 'uq_ai_batch_item_source_chunk', 'index', 'AI batch item dedup', 'CREATE UNIQUE INDEX uq_ai_batch_item_source_chunk ON public.ai_batch_items USING btree (batch_job_id, source_type, source_id, chunk_index)');

CREATE TEMP VIEW p02_actual(obj_name, obj_kind, actual_def, table_name) AS
  SELECT i.indexname,
         'index',
         regexp_replace(i.indexdef, '\s+', ' ', 'g'),
         i.tablename
    FROM pg_indexes i
   WHERE i.schemaname = 'public'
  UNION ALL
  SELECT c.conname,
         'constraint',
         regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g'),
         t.relname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public';

\echo ''
\echo '=== PER-OBJECT VERDICT ===================================================='
SELECT e.severity,
       e.obj_name,
       CASE
         WHEN a.obj_name IS NULL THEN 'FAIL'
         WHEN a.actual_def = e.expected_def THEN 'PASS'
         ELSE 'MISMATCH'
       END AS verdict,
       e.purpose
  FROM p02_expected e
  LEFT JOIN p02_actual a
         ON a.obj_name = e.obj_name AND a.obj_kind = e.obj_kind
 ORDER BY
   CASE WHEN a.obj_name IS NULL THEN 0
        WHEN a.actual_def <> e.expected_def THEN 1 ELSE 2 END,
   e.severity, e.obj_name;

\echo ''
\echo '=== FAILURES IN FULL (expected vs actual) ================================='
SELECT e.severity, e.obj_name,
       CASE WHEN a.obj_name IS NULL THEN 'ABSENT' ELSE 'DEFINITION DIFFERS' END AS problem,
       e.expected_def AS expected,
       COALESCE(a.actual_def, '(nothing — object does not exist)') AS actual
  FROM p02_expected e
  LEFT JOIN p02_actual a
         ON a.obj_name = e.obj_name AND a.obj_kind = e.obj_kind
 WHERE a.obj_name IS NULL OR a.actual_def <> e.expected_def
 ORDER BY e.severity, e.obj_name;

\echo ''
\echo '=== SUMMARY ==============================================================='
SELECT e.severity,
       count(*) AS checked,
       count(*) FILTER (WHERE a.obj_name IS NOT NULL AND a.actual_def = e.expected_def) AS pass,
       count(*) FILTER (WHERE a.obj_name IS NOT NULL AND a.actual_def <> e.expected_def) AS mismatch,
       count(*) FILTER (WHERE a.obj_name IS NULL) AS fail
  FROM p02_expected e
  LEFT JOIN p02_actual a
         ON a.obj_name = e.obj_name AND a.obj_kind = e.obj_kind
 GROUP BY e.severity ORDER BY e.severity;

\echo ''
\echo '=== OVERALL VERDICT ======================================================='
SELECT CASE
    WHEN count(*) FILTER (WHERE a.obj_name IS NULL AND e.severity = 'P0') > 0
      THEN 'CRITICAL — ' || count(*) FILTER (WHERE a.obj_name IS NULL AND e.severity = 'P0')
           || ' P0 integrity guard(s) ABSENT. PostgreSQL is not enforcing them; '
           || 'the application is the only thing standing between you and duplicate '
           || 'charges, replayed webhooks or duplicate accounts.'
    WHEN count(*) FILTER (WHERE a.obj_name IS NULL) > 0
      THEN 'DEGRADED — ' || count(*) FILTER (WHERE a.obj_name IS NULL)
           || ' P1 guard(s) absent. No P0 guard is missing.'
    WHEN count(*) FILTER (WHERE a.actual_def <> e.expected_def) > 0
      THEN 'REVIEW — every guard is present, but '
           || count(*) FILTER (WHERE a.actual_def <> e.expected_def)
           || ' definition(s) differ from canonical. Read the FAILURES section.'
    ELSE 'ENFORCED — all ' || count(*) || ' critical integrity guards are present '
         || 'and match the canonical definition.'
  END AS overall
  FROM p02_expected e
  LEFT JOIN p02_actual a
         ON a.obj_name = e.obj_name AND a.obj_kind = e.obj_kind;

\echo ''
\echo '=== NON-INDEX GUARDS: extensions and triggers ============================='
-- These are NOT managed by TypeORM at all (it neither creates nor drops them),
-- so they are immune to the synchronize failure mode — but they can still be
-- missing if a migration never ran. `transactions_no_mutate` enforces the
-- append-only ledger; without it, UPDATE/DELETE on transactions silently works.
SELECT 'EXTENSION btree_gist' AS guard,
       CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='btree_gist')
            THEN 'PASS' ELSE 'FAIL' END AS verdict,
       'required by appointments_no_overlap' AS purpose
UNION ALL
SELECT 'EXTENSION pg_trgm',
       CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_trgm')
            THEN 'PASS' ELSE 'FAIL' END,
       'required by the trigram search indexes'
UNION ALL
SELECT 'TRIGGER transactions_no_mutate',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
               WHERE NOT tg.tgisinternal AND c.relname = 'transactions'
                 AND tg.tgname = 'transactions_no_mutate')
            THEN 'PASS' ELSE 'FAIL' END,
       'transactions ledger is append-only (blocks UPDATE/DELETE)'
UNION ALL
SELECT 'FUNCTION trg_transactions_immutable',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname='public' AND p.proname='trg_transactions_immutable')
            THEN 'PASS' ELSE 'FAIL' END,
       'the function the trigger above calls';

\echo ''
\echo '=== TENANT ISOLATION: every tenant-scoped table must have a tenant FK ====='
-- Checked structurally, not by name: TypeORM renames foreign keys to hash
-- names, so a name-based check would report false failures. This asks the only
-- question that matters — does a FOREIGN KEY to tenants(id) exist on the
-- tenant column, whatever it is called?
WITH tenant_cols AS (
  SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public'
   WHERE c.table_schema = 'public'
     AND c.column_name IN ('tenantId', 'tenant_id')
),
tenant_fks AS (
  SELECT cl.relname AS table_name, a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class rf ON rf.oid = con.confrelid
    JOIN unnest(con.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
   WHERE con.contype = 'f' AND rf.relname = 'tenants'
)
SELECT tc.table_name, tc.column_name,
       CASE WHEN tf.table_name IS NULL THEN 'FAIL — no FK to tenants' ELSE 'PASS' END AS verdict
  FROM tenant_cols tc
  LEFT JOIN tenant_fks tf
         ON tf.table_name = tc.table_name AND tf.column_name = tc.column_name
 WHERE tf.table_name IS NULL
 ORDER BY tc.table_name;

\echo '(no rows above = every tenant-scoped table has a tenant foreign key)'

\echo ''
\echo '=== CONTEXT (informational — NOT a verdict) ==============================='
-- Hash-named indexes are NOT proof of synchronize damage: many migrations in
-- this repository were themselves TypeORM-generated and create hash-named
-- indexes. Measured on four real databases: a clean, fully-migrated one had 58
-- and passed all 43 checks; a synchronize-damaged one had 126. Use this only
-- as a weak corroborating signal alongside the verdict above, never instead of
-- it. `migrations_table_present = 0` DOES mean the schema was never migrated.
SELECT (SELECT count(*) FROM pg_indexes
         WHERE schemaname='public' AND indexname ~ '^(IDX|UQ|REL)_[0-9a-f]{26,}$')
         AS typeorm_hash_named_indexes,
       (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='migrations')
         AS migrations_table_present;
\echo ''
