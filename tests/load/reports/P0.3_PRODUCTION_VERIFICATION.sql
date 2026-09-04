-- ===========================================================================
-- P0.3_PRODUCTION_VERIFICATION.sql
--
-- Answers, for one database, the only question that matters:
--   "Is PostgreSQL CURRENTLY ENFORCING each critical integrity rule, and if
--    not, can the guard even be installed — or is there data in the way?"
--
-- Supersedes P0.2_PRODUCTION_VERIFICATION.sql. Everything that script checked
-- is checked here identically; what is NEW is §5, the conflicting-data
-- pre-check (P0.3 RULE 10). That distinction is not academic. A missing guard
-- with no conflicts is a one-line repair. A missing guard WITH conflicts is a
-- one-way door: `CREATE UNIQUE INDEX` fails while duplicates exist, so the
-- guard can never be installed until a human decides which rows are real —
-- and P0.3 found exactly that case on a real database (FIX-001).
--
-- ── SAFETY ─────────────────────────────────────────────────────────────────
-- Reads pg_catalog, information_schema, and — in §5 only — COUNTS rows in
-- application tables. It writes NOTHING: no INSERT, UPDATE, DELETE, or
-- persistent DDL anywhere in this file. It creates three TEMPORARY VIEWs
-- (pg_temp, session-local, invisible to other connections, gone on
-- disconnect) to hold the expected values. If policy forbids even temp
-- objects on production, run it against a read replica.
--
-- COST: §5 aggregates over the tables that back each guard. On a large
-- production database that is real work — seconds to minutes on multi-million
-- row tables, and it competes for I/O. It takes no locks that block writers
-- (plain SELECT under MVCC), but prefer a read replica or a quiet window. To
-- skip it entirely, stop after §4; §1-§4 are catalog-only and near-instant.
--
--   psql "$DATABASE_URL" -f P0.3_PRODUCTION_VERIFICATION.sql
--
-- ── WHY IT EXISTS ──────────────────────────────────────────────────────────
-- The `migrations` table is NOT evidence. P0.1 proved a migration can be
-- recorded as applied while its object is absent (observed on two separate
-- databases). P0.2 proved one TYPEORM_SYNCHRONIZE=true boot removes 32
-- integrity objects from a fully-migrated schema. Only pg_catalog is
-- authoritative.
--
-- ── VERDICTS ───────────────────────────────────────────────────────────────
--   PASS       present, and its definition matches the canonical one exactly
--   FAIL       ABSENT — PostgreSQL is NOT enforcing this rule
--   MISMATCH   present, but the definition DIFFERS from canonical (read it)
--   ENFORCED_RENAMED  the RULE is enforced, under a different (TypeORM hash)
--              name. Not a defect in what the database accepts; it does mean
--              this schema was touched by the synchronizer at some point.
--
-- Expected definitions come from a database built by running the full
-- migration chain from empty (133 migrations) on PostgreSQL 18. On a different
-- major version, pg_get_constraintdef / pg_indexes may format
-- identically-meaning SQL differently — a MISMATCH is a prompt to read the two
-- strings, not proof of a defect.
-- ===========================================================================
\pset pager off
\set ON_ERROR_STOP off

\echo ''
\echo '=== 0. TARGET =============================================================='
SELECT current_database() AS database_name,
       current_setting('server_version') AS postgres_version,
       now() AS checked_at,
       (SELECT count(*) FROM pg_tables
         WHERE schemaname='public' AND tablename='migrations') AS migrations_table_present;

CREATE TEMP VIEW p03_expected(severity, obj_name, obj_kind, purpose, expected_def) AS
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

CREATE TEMP VIEW p03_actual(obj_name, obj_kind, actual_def, table_name) AS
  SELECT i.indexname, 'index',
         regexp_replace(i.indexdef, '\s+', ' ', 'g'), i.tablename
    FROM pg_indexes i WHERE i.schemaname = 'public'
  UNION ALL
  SELECT c.conname, 'constraint',
         regexp_replace(pg_get_constraintdef(c.oid), '\s+', ' ', 'g'), t.relname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public';

-- ── The name-independent view, and why P0.3 added it ───────────────────────
--
-- TypeORM's synchronizer RENAMES every index it recreates from entity
-- metadata, to `IDX_<28 hex>`. So a guard declared on an entity is dropped and
-- immediately re-created under a hash name: the RULE survives, the NAME does
-- not. A purely name-based check calls that a FAIL.
--
-- It is not one, and the difference is large. Measured 2026-09-03 on the live
-- local databases: by name, dev showed 15/43 and perf 24/43; comparing the
-- actual index SHAPE (uniqueness, table, columns, predicate) instead, the true
-- figures are 20/43 and 26/43. P0.2's headline "dev 15/43" understated what
-- PostgreSQL was enforcing by five guards. (Every P0 count was unchanged —
-- none of the renamed survivors is P0 — so no conclusion moved; the number
-- did.)
--
-- Reporting a false FAIL on production would send an operator to install a
-- guard that already exists, so ENFORCED_RENAMED is its own verdict here:
-- the rule holds, and the only defect is the name.
CREATE TEMP VIEW p03_shape(shape, obj_name) AS
  SELECT regexp_replace(
           regexp_replace(indexdef, '\s+', ' ', 'g'),
           'CREATE (UNIQUE )?INDEX \S+ ON ', 'CREATE \1INDEX ON '),
         indexname
    FROM pg_indexes WHERE schemaname = 'public';

CREATE TEMP VIEW p03_verdict(severity, obj_name, verdict, purpose, expected_def, actual_def) AS
  SELECT e.severity, e.obj_name,
         CASE
           WHEN a.obj_name IS NOT NULL AND a.actual_def = e.expected_def THEN 'PASS'
           WHEN a.obj_name IS NOT NULL THEN 'MISMATCH'
           WHEN s.obj_name IS NOT NULL THEN 'ENFORCED_RENAMED'
           ELSE 'FAIL'
         END,
         e.purpose, e.expected_def,
         COALESCE(a.actual_def, 'ENFORCED under the name "' || s.obj_name || '"')
    FROM p03_expected e
    LEFT JOIN p03_actual a
           ON a.obj_name = e.obj_name AND a.obj_kind = e.obj_kind
    LEFT JOIN LATERAL (
      SELECT p.obj_name FROM p03_shape p
       WHERE e.obj_kind = 'index'
         AND p.shape = regexp_replace(e.expected_def,
               'CREATE (UNIQUE )?INDEX \S+ ON ', 'CREATE \1INDEX ON ')
       LIMIT 1
    ) s ON true;

\echo ''
\echo '=== 1. MACHINE-READABLE STATUS (one line, parse this in CI) ================'
-- Stable, greppable, and safe to assert on:
--   P03_STATUS=<ENFORCED|DEGRADED|REVIEW|CRITICAL> P0_PASS=n P0_FAIL=n ...
SELECT 'P03_STATUS='
       || CASE
            WHEN count(*) FILTER (WHERE verdict='FAIL' AND severity='P0') > 0 THEN 'CRITICAL'
            WHEN count(*) FILTER (WHERE verdict='FAIL') > 0 THEN 'DEGRADED'
            WHEN count(*) FILTER (WHERE verdict IN ('MISMATCH','ENFORCED_RENAMED')) > 0 THEN 'REVIEW'
            ELSE 'ENFORCED' END
       || ' P0_PASS='     || count(*) FILTER (WHERE verdict='PASS'     AND severity='P0')
       || ' P0_FAIL='     || count(*) FILTER (WHERE verdict='FAIL'     AND severity='P0')
       || ' P0_MISMATCH=' || count(*) FILTER (WHERE verdict='MISMATCH' AND severity='P0')
       || ' P0_RENAMED='  || count(*) FILTER (WHERE verdict='ENFORCED_RENAMED' AND severity='P0')
       || ' P1_PASS='     || count(*) FILTER (WHERE verdict='PASS'     AND severity='P1')
       || ' P1_FAIL='     || count(*) FILTER (WHERE verdict='FAIL'     AND severity='P1')
       || ' P1_MISMATCH=' || count(*) FILTER (WHERE verdict='MISMATCH' AND severity='P1')
       || ' P1_RENAMED='  || count(*) FILTER (WHERE verdict='ENFORCED_RENAMED' AND severity='P1')
       || ' ENFORCED_TOTAL=' || count(*) FILTER (WHERE verdict <> 'FAIL')
       || ' TOTAL='       || count(*)
       AS p03_status
  FROM p03_verdict;

\echo ''
\echo '=== 2. PER-OBJECT VERDICT (failures first) ================================='
SELECT severity, obj_name, verdict, purpose
  FROM p03_verdict
 ORDER BY CASE verdict WHEN 'FAIL' THEN 0 WHEN 'MISMATCH' THEN 1
                                WHEN 'ENFORCED_RENAMED' THEN 2 ELSE 3 END,
          severity, obj_name;

\echo ''
\echo '=== 3. FAILURES IN FULL (expected vs actual) ==============================='
SELECT severity, obj_name,
       CASE WHEN verdict='FAIL' THEN 'ABSENT'
            WHEN verdict='ENFORCED_RENAMED' THEN 'ENFORCED, WRONG NAME'
            ELSE 'DEFINITION DIFFERS' END AS problem,
       expected_def AS expected,
       COALESCE(actual_def, '(nothing - object does not exist)') AS actual
  FROM p03_verdict WHERE verdict <> 'PASS'
 ORDER BY severity, obj_name;

\echo ''
\echo '=== 4. NON-INDEX GUARDS: extensions, trigger, function ===================='
-- Not managed by TypeORM at all (it neither creates nor drops triggers), so
-- these are immune to the synchronize failure mode — but they can still be
-- missing if a migration never ran. Without transactions_no_mutate, UPDATE and
-- DELETE on the transactions ledger silently succeed.
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
               WHERE NOT tg.tgisinternal AND c.relname='transactions'
                 AND tg.tgname='transactions_no_mutate')
            THEN 'PASS' ELSE 'FAIL' END,
       'transactions ledger is append-only (blocks UPDATE/DELETE)'
UNION ALL
SELECT 'FUNCTION trg_transactions_immutable',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
               WHERE n.nspname='public' AND p.proname='trg_transactions_immutable')
            THEN 'PASS' ELSE 'FAIL' END,
       'the function the trigger above calls'
UNION ALL
SELECT 'CONSTRAINT appointments_no_overlap IS an EXCLUSION',
       CASE WHEN EXISTS (
              SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
               WHERE c.conname='appointments_no_overlap' AND t.relname='appointments'
                 AND c.contype='x')
            THEN 'PASS' ELSE 'FAIL' END,
       'P0.1: a same-named btree index would pass a naive presence check while enforcing nothing';

\echo ''
\echo '=== 5. CONFLICTING DATA — can a missing guard even be installed? ==========='
-- NEW IN P0.3, and the reason this file supersedes the P0.2 one.
--
-- For every guard, counts the rows ALREADY present that violate its rule.
-- PostgreSQL semantics are reproduced exactly: a unique index treats NULLs as
-- DISTINCT, so a group whose key contains a NULL is never a conflict; a CHECK
-- constraint passes when its expression is NULL, so a violation is
-- `expr IS FALSE`, not `NOT expr`.
--
-- HOW TO READ IT:
--   guard absent, conflicts = 0  -> installable now. One migration.
--   guard absent, conflicts > 0  -> BLOCKED. `CREATE UNIQUE INDEX` will fail.
--                                   Someone must decide which rows are real
--                                   BEFORE the guard can exist. Do not delete
--                                   rows to make the DDL pass — see
--                                   P0.3_REPAIR_RUNBOOK.md.
--   guard present                -> conflicts are 0 by construction.
--
-- This is the expensive section (see COST in the header). Stop after §4 to
-- skip it.
CREATE TEMP VIEW p03_conflict_checks(obj_name, table_name, unit, check_sql) AS
VALUES
    ('appointments_no_overlap', 'appointments', 'overlapping pairs', 'SELECT count(*) FROM appointments a JOIN appointments b ON a."staffId" = b."staffId" AND a.id < b.id AND a.status NOT IN (''CANCELLED'',''NO_SHOW'') AND a.deleted_at IS NULL AND b.status NOT IN (''CANCELLED'',''NO_SHOW'') AND b.deleted_at IS NULL AND tstzrange(a.start_at, a.end_at, ''[)'') && tstzrange(b.start_at, b.end_at, ''[)'')'),
    ('uq_refund_idem', 'refunds', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.refunds WHERE (idempotency_key IS NOT NULL) AND ("tenantId") IS NOT NULL AND (idempotency_key) IS NOT NULL GROUP BY "tenantId", idempotency_key HAVING count(*) > 1) x'),
    ('uq_refund_gateway_id', 'refunds', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.refunds WHERE (gateway_refund_id IS NOT NULL) AND (gateway_refund_id) IS NOT NULL GROUP BY gateway_refund_id HAVING count(*) > 1) x'),
    ('uq_txn_webhook_event', 'transactions', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.transactions WHERE (((type)::text = ''webhook''::text) AND (gateway_transaction_id IS NOT NULL)) AND (gateway_transaction_id) IS NOT NULL GROUP BY gateway_transaction_id HAVING count(*) > 1) x'),
    ('uq_payments_appointment_pending', 'payments', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.payments WHERE ((status = ''PENDING''::payments_status_enum) AND ("appointmentId" IS NOT NULL)) AND ("appointmentId") IS NOT NULL GROUP BY "appointmentId" HAVING count(*) > 1) x'),
    ('uq_settlement_adj_refund', 'settlement_adjustments', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.settlement_adjustments WHERE (refund_id IS NOT NULL) AND (refund_id) IS NOT NULL GROUP BY refund_id HAVING count(*) > 1) x'),
    ('UQ_resource_purchases_tenant_idempotency', 'resource_purchases', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.resource_purchases WHERE ("tenantId") IS NOT NULL AND (idempotency_key) IS NOT NULL GROUP BY "tenantId", idempotency_key HAVING count(*) > 1) x'),
    ('UQ_sub_invoice_webhook_event', 'subscription_invoices', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.subscription_invoices WHERE (webhook_event_id IS NOT NULL) AND (webhook_event_id) IS NOT NULL GROUP BY webhook_event_id HAVING count(*) > 1) x'),
    ('UQ_sub_invoice_period', 'subscription_invoices', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.subscription_invoices WHERE (status <> ''VOID''::subscription_invoices_status_enum) AND (subscription_id) IS NOT NULL AND (period_start) IS NOT NULL GROUP BY subscription_id, period_start HAVING count(*) > 1) x'),
    ('UQ_tenant_entitlement_ledger_source_purchase', 'tenant_entitlement_ledger', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.tenant_entitlement_ledger WHERE (("sourcePurchaseId" IS NOT NULL) AND ((direction)::text = ''grant''::text)) AND ("sourcePurchaseId") IS NOT NULL GROUP BY "sourcePurchaseId" HAVING count(*) > 1) x'),
    ('UQ_tenant_entitlement_ledger_source_refund', 'tenant_entitlement_ledger', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.tenant_entitlement_ledger WHERE ("sourceRefundId" IS NOT NULL) AND ("sourceRefundId") IS NOT NULL GROUP BY "sourceRefundId" HAVING count(*) > 1) x'),
    ('UQ_integration_inbound_events_replay', 'integration_inbound_events', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_inbound_events WHERE ("tenantId") IS NOT NULL AND ("endpointId") IS NOT NULL AND (provider_event_id) IS NOT NULL GROUP BY "tenantId", "endpointId", provider_event_id HAVING count(*) > 1) x'),
    ('uq_message_wa_id', 'messages', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.messages WHERE (wa_message_id IS NOT NULL) AND ("tenantId") IS NOT NULL AND (wa_message_id) IS NOT NULL GROUP BY "tenantId", wa_message_id HAVING count(*) > 1) x'),
    ('uq_message_status', 'message_status_logs', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.message_status_logs WHERE ("messageId") IS NOT NULL AND (status) IS NOT NULL GROUP BY "messageId", status HAVING count(*) > 1) x'),
    ('UQ_integration_oauth_states_state', 'integration_oauth_states', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_oauth_states WHERE (state) IS NOT NULL GROUP BY state HAVING count(*) > 1) x'),
    ('uq_ai_tool_call_idem', 'ai_tool_calls', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.ai_tool_calls WHERE (tenant_id) IS NOT NULL AND (idempotency_key) IS NOT NULL GROUP BY tenant_id, idempotency_key HAVING count(*) > 1) x'),
    ('uq_user_email_global', 'users', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.users WHERE ((deleted_at IS NULL) AND (email IS NOT NULL)) AND (email) IS NOT NULL GROUP BY email HAVING count(*) > 1) x'),
    ('ck_user_email_lowercase', 'users', 'rows with a non-lowercase email', 'SELECT count(*) FROM users WHERE ((email IS NULL) OR (email::text = lower(email::text))) IS FALSE'),
    ('UQ_customers_tenant_email', 'customers', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.customers WHERE (deleted_at IS NULL) AND ("tenantId") IS NOT NULL AND (email) IS NOT NULL GROUP BY "tenantId", email HAVING count(*) > 1) x'),
    ('UQ_customers_tenant_national_id', 'customers', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.customers WHERE ((national_id IS NOT NULL) AND (deleted_at IS NULL)) AND ("tenantId") IS NOT NULL AND (national_id) IS NOT NULL GROUP BY "tenantId", national_id HAVING count(*) > 1) x'),
    ('UQ_email_suppressions_tenant_email', 'email_suppressions', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.email_suppressions WHERE (tenant_id) IS NOT NULL AND (email) IS NOT NULL GROUP BY tenant_id, email HAVING count(*) > 1) x'),
    ('UQ_email_logs_idempotency', 'email_logs', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.email_logs WHERE (idempotency_key) IS NOT NULL GROUP BY idempotency_key HAVING count(*) > 1) x'),
    ('UQ_notification_logs_source_ref', 'notification_logs', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.notification_logs WHERE (source_ref IS NOT NULL) AND (source_ref) IS NOT NULL GROUP BY source_ref HAVING count(*) > 1) x'),
    ('UQ_scheduled_notifications_source_ref', 'scheduled_notifications', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.scheduled_notifications WHERE (source_ref IS NOT NULL) AND (source_ref) IS NOT NULL GROUP BY source_ref HAVING count(*) > 1) x'),
    ('UQ_scheduled_notifications_provider_ref', 'scheduled_notifications', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.scheduled_notifications WHERE (provider_ref IS NOT NULL) AND (provider_ref) IS NOT NULL GROUP BY provider_ref HAVING count(*) > 1) x'),
    ('UQ_campaign_recipients_provider_ref', 'campaign_recipients', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.campaign_recipients WHERE (provider_ref IS NOT NULL) AND (provider_ref) IS NOT NULL GROUP BY provider_ref HAVING count(*) > 1) x'),
    ('uq_recipient_run_customer', 'campaign_recipients', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.campaign_recipients WHERE ("runId") IS NOT NULL AND ("customerId") IS NOT NULL GROUP BY "runId", "customerId" HAVING count(*) > 1) x'),
    ('UQ_in_app_notifications_recipient_dedupe', 'in_app_notifications', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.in_app_notifications WHERE (dedupe_key IS NOT NULL) AND (recipient_user_id) IS NOT NULL AND (dedupe_key) IS NOT NULL GROUP BY recipient_user_id, dedupe_key HAVING count(*) > 1) x'),
    ('UQ_subscription_usage_tenant_period_unsubscribed', 'subscription_usage', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.subscription_usage WHERE (subscription_id IS NULL) AND (tenant_id) IS NOT NULL AND (period_month) IS NOT NULL GROUP BY tenant_id, period_month HAVING count(*) > 1) x'),
    ('uq_dashboard_metric', 'dashboard_metrics', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.dashboard_metrics WHERE ("tenantId") IS NOT NULL AND (metric_key) IS NOT NULL AND (period) IS NOT NULL GROUP BY "tenantId", metric_key, period HAVING count(*) > 1) x'),
    ('UQ_integration_id_map_external', 'integration_id_map', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_id_map WHERE (unlinked_at IS NULL) AND ("tenantId") IS NOT NULL AND ("connectionId") IS NOT NULL AND (resource_type) IS NOT NULL AND (external_id) IS NOT NULL GROUP BY "tenantId", "connectionId", resource_type, external_id HAVING count(*) > 1) x'),
    ('UQ_integration_id_map_internal', 'integration_id_map', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_id_map WHERE (unlinked_at IS NULL) AND ("tenantId") IS NOT NULL AND ("connectionId") IS NOT NULL AND (resource_type) IS NOT NULL AND (internal_resource_id) IS NOT NULL GROUP BY "tenantId", "connectionId", resource_type, internal_resource_id HAVING count(*) > 1) x'),
    ('UQ_integration_conflicts_open', 'integration_conflicts', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_conflicts WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''resolving''::character varying, ''stale''::character varying])::text[])) AND ("tenantId") IS NOT NULL AND ("connectionId") IS NOT NULL AND (resource_type) IS NOT NULL AND (external_id) IS NOT NULL GROUP BY "tenantId", "connectionId", resource_type, external_id HAVING count(*) > 1) x'),
    ('UQ_integration_sync_active', 'integration_sync_jobs', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_sync_jobs WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''running''::character varying])::text[])) AND ("tenantId") IS NOT NULL AND ("connectionId") IS NOT NULL AND (resource_type) IS NOT NULL AND (direction) IS NOT NULL GROUP BY "tenantId", "connectionId", resource_type, direction HAVING count(*) > 1) x'),
    ('UQ_integration_staff_provisioning_open', 'integration_staff_provisioning', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_staff_provisioning WHERE ((status)::text = ANY ((ARRAY[''pending''::character varying, ''ambiguous''::character varying])::text[])) AND ("tenantId") IS NOT NULL AND ("connectionId") IS NOT NULL AND (external_id) IS NOT NULL GROUP BY "tenantId", "connectionId", external_id HAVING count(*) > 1) x'),
    ('UQ_integration_webhook_endpoints_connection', 'integration_webhook_endpoints', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.integration_webhook_endpoints WHERE ("connectionId") IS NOT NULL GROUP BY "connectionId" HAVING count(*) > 1) x'),
    ('UQ_billing_upgrade_requests_active_target', 'billing_upgrade_requests', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.billing_upgrade_requests WHERE ((status)::text = ANY ((ARRAY[''pending_review''::character varying, ''awaiting_owner_approval''::character varying, ''payment_processing''::character varying, ''payment_failed''::character varying])::text[])) AND ("tenantId") IS NOT NULL AND (COALESCE(feature_key, usage_metric)) IS NOT NULL GROUP BY "tenantId", COALESCE(feature_key, usage_metric) HAVING count(*) > 1) x'),
    ('UQ_tenant_usage_limit_overrides_active', 'tenant_usage_limit_overrides', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.tenant_usage_limit_overrides WHERE (is_active = true) AND ("tenantId") IS NOT NULL AND (metric) IS NOT NULL GROUP BY "tenantId", metric HAVING count(*) > 1) x'),
    ('UQ_feature_definitions_key', 'feature_definitions', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.feature_definitions WHERE (feature_key) IS NOT NULL GROUP BY feature_key HAVING count(*) > 1) x'),
    ('UQ_support_tickets_ticket_number', 'support_tickets', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM support_tickets WHERE ticket_number IS NOT NULL GROUP BY ticket_number HAVING count(*) > 1) x'),
    ('UQ_customer_segments_tenant_name_live', 'customer_segments', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.customer_segments WHERE (deleted_at IS NULL) AND ("tenantId") IS NOT NULL AND (name) IS NOT NULL GROUP BY "tenantId", name HAVING count(*) > 1) x'),
    ('uq_ai_kb_source_content_hash', 'ai_knowledge_bases', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.ai_knowledge_bases WHERE ("tenantId") IS NOT NULL AND ("agentId") IS NOT NULL AND (COALESCE(source_id, ''00000000-0000-0000-0000-000000000000''::uuid)) IS NOT NULL AND (content_hash) IS NOT NULL GROUP BY "tenantId", "agentId", COALESCE(source_id, ''00000000-0000-0000-0000-000000000000''::uuid), content_hash HAVING count(*) > 1) x'),
    ('uq_ai_batch_item_source_chunk', 'ai_batch_items', 'excess rows', 'SELECT coalesce(sum(n) - count(*), 0) FROM ( SELECT count(*) n FROM public.ai_batch_items WHERE (batch_job_id) IS NOT NULL AND (source_type) IS NOT NULL AND (source_id) IS NOT NULL AND (chunk_index) IS NOT NULL GROUP BY batch_job_id, source_type, source_id, chunk_index HAVING count(*) > 1) x');

\echo ''
\echo '-- 5a. The checks to run. Each row is a self-contained, read-only query.'
\echo '--     Run only the rows whose guard shows FAIL in §2 — the rest are'
\echo '--     conflict-free by construction, and skipping them avoids the scan.'
SELECT c.obj_name, v.verdict, c.table_name, c.unit, c.check_sql
  FROM p03_conflict_checks c
  JOIN p03_verdict v ON v.obj_name = c.obj_name
 WHERE v.verdict = 'FAIL'
 ORDER BY v.severity, c.obj_name;

\echo ''
\echo '-- 5b. Executes every check above automatically. Read-only (SELECT count).'
\echo '--     Comment this block out if you would rather run 5a by hand.'
DO $p03$
DECLARE
  r      record;
  n      bigint;
  hits   int := 0;
BEGIN
  FOR r IN
    SELECT c.obj_name, c.table_name, c.unit, c.check_sql, v.verdict
      FROM p03_conflict_checks c
      JOIN p03_verdict v ON v.obj_name = c.obj_name
     WHERE v.verdict = 'FAIL'
     ORDER BY v.severity, c.obj_name
  LOOP
    BEGIN
      EXECUTE r.check_sql INTO n;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'CONFLICT CHECK SKIPPED  %  (%)', rpad(r.obj_name, 48), SQLERRM;
      CONTINUE;
    END;
    IF n > 0 THEN
      hits := hits + 1;
      RAISE NOTICE 'BLOCKED   %  % % in %  <- the guard CANNOT be created until this is resolved',
        rpad(r.obj_name, 48), n, r.unit, r.table_name;
    ELSE
      RAISE NOTICE 'clear     %  0 conflicts - installable now', rpad(r.obj_name, 48);
    END IF;
  END LOOP;
  IF hits = 0 THEN
    RAISE NOTICE '--> No conflicting data. Every missing guard can be installed by migration alone.';
  ELSE
    RAISE NOTICE '--> % guard(s) BLOCKED by existing data. Each needs a documented business decision', hits;
    RAISE NOTICE '    before any migration can install it. See P0.3_REPAIR_RUNBOOK.md section 3.';
  END IF;
END
$p03$;

\echo ''
\echo '=== 6. TENANT ISOLATION: tenant-scoped tables with no FK to tenants ========'
-- Checked STRUCTURALLY, never by name: TypeORM renames every foreign key it
-- recreates, so a name-based check reports false failures. This asks the only
-- question that matters - does a FOREIGN KEY to tenants(id) exist on the
-- tenant column, whatever it happens to be called?
--
-- Rows here are NOT automatically defects. P0.3 established that several are
-- deliberate (append-only telemetry) and two are structurally impossible today
-- because the column is "character varying", not "uuid". See
-- P0.3_FINDINGS.md P03-006.
WITH tenant_cols AS (
  SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c
    JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname='public'
   WHERE c.table_schema='public' AND c.column_name IN ('tenantId','tenant_id')),
tenant_fks AS (
  SELECT cl.relname AS table_name, a.attname AS column_name
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class rf ON rf.oid = con.confrelid
    JOIN unnest(con.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
   WHERE con.contype='f' AND rf.relname='tenants')
SELECT tc.table_name, tc.column_name, tc.data_type,
       CASE WHEN tc.data_type <> 'uuid'
            THEN 'NO FK - and impossible without a column type change'
            ELSE 'NO FK' END AS status
  FROM tenant_cols tc
  LEFT JOIN tenant_fks tf
    ON tf.table_name = tc.table_name AND tf.column_name = tc.column_name
 WHERE tf.table_name IS NULL
 ORDER BY tc.table_name;

\echo '(no rows above = every tenant-scoped table has a tenant foreign key)'

\echo ''
\echo '=== 7. MIGRATION HISTORY (context only - NOT a verdict) ===================='
-- P0.1 and P0.2 both found databases recording every migration while missing
-- P0 guards. A migration count therefore proves nothing on its own; it is here
-- only to help interpret §1. `migrations_table_present = 0` in §0 DOES mean the
-- schema was never migrated.
SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='migrations') AS has_migrations_table,
       (SELECT count(*) FROM pg_indexes WHERE schemaname='public') AS total_indexes,
       (SELECT count(*) FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
          JOIN pg_namespace n ON n.oid=t.relnamespace
         WHERE n.nspname='public' AND c.contype='f') AS total_foreign_keys;
\echo ''
