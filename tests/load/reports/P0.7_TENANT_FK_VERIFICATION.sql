-- ============================================================================
-- P0.7 — TENANT ISOLATION FORENSIC VERIFICATION (read-only)
-- ============================================================================
-- Scans the 15 tenant-scoped tables production reported without a foreign
-- key to `tenants` (P0.4, operator-run 2026-09-04) for: column type, orphan
-- rows (a non-null tenant reference that names no row in `tenants`), and
-- basic shape (nullable? indexed?).
--
-- READ-ONLY. Every statement below is SELECT. No INSERT, UPDATE, DELETE,
-- ALTER, DROP, CREATE (non-TEMP), TRUNCATE, GRANT, REVOKE, VACUUM or REINDEX.
-- Scanned the same way P0.3's script was (static + dynamic verification) —
-- see tests/load/reports/p07/ for that evidence if generated.
--
-- Safe to run on production: every query is a SELECT count(*) or a bounded
-- SELECT of safe identifiers (ids and counts only — never row content).
--
-- Run: psql "$DATABASE_URL" -f tests/load/reports/P0.7_TENANT_FK_VERIFICATION.sql
-- ============================================================================

\pset pager off
\timing on

\echo ''
\echo '=== 0. TARGET =============================================================='
SELECT current_database() AS database, version() AS postgres_version;
\echo ''

\echo '=== 1. COLUMN SHAPE — type, nullability, per table ========================='
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND c.table_name IN (
     'admin_notifications', 'ai_execution_metrics', 'ai_kb_embeddings',
     'ai_memories', 'ai_memory_embeddings', 'ai_tool_calls', 'email_logs',
     'free_access_overrides', 'settlement_adjustments', 'subscription_invoices',
     'subscription_usage', 'tenant_counters', 'verification_audit_logs',
     'workflows', 'workflow_runs')
   AND c.column_name IN ('tenant_id', 'tenantId')
 ORDER BY c.table_name;
\echo ''

\echo '=== 2. ORPHAN COUNTS — non-null tenant reference naming no row in tenants ==='
-- One row per table. `total_rows` and `orphans` only — no row content, no
-- sample ids (a tenant-scoped table's row ids are not sensitive on their
-- own, but this script stays counts-only throughout on principle, matching
-- P0.3/P0.4's convention).
SELECT 'admin_notifications' AS table_name,
       count(*) AS total_rows,
       count(*) FILTER (WHERE tenant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = admin_notifications.tenant_id)) AS orphans
  FROM admin_notifications
UNION ALL
SELECT 'ai_execution_metrics', count(*),
       count(*) FILTER (WHERE "tenantId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ai_execution_metrics."tenantId"))
  FROM ai_execution_metrics
UNION ALL
SELECT 'ai_kb_embeddings', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ai_kb_embeddings.tenant_id))
  FROM ai_kb_embeddings
UNION ALL
SELECT 'ai_memories', count(*),
       count(*) FILTER (WHERE "tenantId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ai_memories."tenantId"))
  FROM ai_memories
UNION ALL
SELECT 'ai_memory_embeddings', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ai_memory_embeddings.tenant_id))
  FROM ai_memory_embeddings
UNION ALL
SELECT 'ai_tool_calls', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = ai_tool_calls.tenant_id))
  FROM ai_tool_calls
UNION ALL
SELECT 'email_logs', count(*),
       count(*) FILTER (WHERE tenant_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = email_logs.tenant_id))
  FROM email_logs
UNION ALL
SELECT 'free_access_overrides', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = free_access_overrides.tenant_id))
  FROM free_access_overrides
UNION ALL
SELECT 'settlement_adjustments', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = settlement_adjustments.tenant_id))
  FROM settlement_adjustments
UNION ALL
-- varchar columns: cast-guarded so a non-uuid-shaped value never errors the
-- whole scan (reported as its own row instead — see §3).
SELECT 'subscription_invoices', count(*),
       count(*) FILTER (WHERE tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = subscription_invoices.tenant_id::uuid))
  FROM subscription_invoices
UNION ALL
SELECT 'subscription_usage', count(*),
       count(*) FILTER (WHERE tenant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = subscription_usage.tenant_id::uuid))
  FROM subscription_usage
UNION ALL
SELECT 'tenant_counters', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = tenant_counters.tenant_id))
  FROM tenant_counters
UNION ALL
SELECT 'verification_audit_logs', count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = verification_audit_logs.tenant_id))
  FROM verification_audit_logs
UNION ALL
SELECT 'workflows', count(*),
       count(*) FILTER (WHERE "tenantId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = workflows."tenantId"))
  FROM workflows
UNION ALL
SELECT 'workflow_runs', count(*),
       count(*) FILTER (WHERE "tenantId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = workflow_runs."tenantId"))
  FROM workflow_runs
 ORDER BY 1;
\echo ''

\echo '=== 3. NON-UUID-SHAPED VALUES — the two varchar columns only ==============='
-- Confirms (or refutes) the P03-006 assumption that every value in these two
-- varchar columns is actually a well-formed uuid string, before any type
-- migration is even considered.
SELECT 'subscription_invoices' AS table_name, count(*) AS non_uuid_shaped
  FROM subscription_invoices
 WHERE tenant_id IS NULL OR tenant_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
UNION ALL
SELECT 'subscription_usage', count(*)
  FROM subscription_usage
 WHERE tenant_id IS NULL OR tenant_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
\echo ''

\echo '=== 4. EXISTING INDEXES on the tenant column ================================'
SELECT tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND tablename IN (
     'admin_notifications', 'ai_execution_metrics', 'ai_kb_embeddings',
     'ai_memories', 'ai_memory_embeddings', 'ai_tool_calls', 'email_logs',
     'free_access_overrides', 'settlement_adjustments', 'subscription_invoices',
     'subscription_usage', 'tenant_counters', 'verification_audit_logs',
     'workflows', 'workflow_runs')
   AND (indexdef ILIKE '%tenant_id%' OR indexdef ILIKE '%tenantid%')
 ORDER BY tablename, indexname;
\echo ''

\echo '=== 5. TABLE SIZE — informs lock/VALIDATE cost, not a verdict ==============='
SELECT relname AS table_name, n_live_tup AS approx_row_count,
       pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS total_size
  FROM pg_stat_user_tables
 WHERE relname IN (
     'admin_notifications', 'ai_execution_metrics', 'ai_kb_embeddings',
     'ai_memories', 'ai_memory_embeddings', 'ai_tool_calls', 'email_logs',
     'free_access_overrides', 'settlement_adjustments', 'subscription_invoices',
     'subscription_usage', 'tenant_counters', 'verification_audit_logs',
     'workflows', 'workflow_runs')
 ORDER BY n_live_tup DESC;
\echo ''

\echo '=== 6. EXISTING FK ON workflow_runs, for reference =========================='
-- workflow_runs already has FK_workflow_runs_workflow (ON DELETE CASCADE) —
-- proof migrations in this schema CAN express an FK; the gap on the tenant
-- column is an omission, not a technical limitation.
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'workflow_runs'::regclass AND contype = 'f';
\echo ''

\echo 'Done. No row was inserted, updated or deleted by this script.'
