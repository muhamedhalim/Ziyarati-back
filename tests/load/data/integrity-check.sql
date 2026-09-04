-- ============================================================================
-- POST-SCENARIO DATA INTEGRITY VERIFICATION  —  ziyarati_perf ONLY
-- ============================================================================
-- Run after every destructive or high-contention scenario. Read-only: it makes
-- no change of any kind, so it is safe to run at any point, including mid-run.
--
-- Each block answers ONE question that a load test can silently get wrong, and
-- every one of them is invisible in k6 output:
--
--   1. DOUBLE BOOKING   — the whole point of the contention scenario. k6 sees
--      201 and 409; only the database can say whether two 201s landed on the
--      same staff member and overlapping window.
--   2. GUARD PRESENT    — whether `appointments_no_overlap` is actually
--      installed. Without it a contention run reports a clean pass while the
--      guarantee it claims to prove does not exist (TypeORM cannot express
--      EXCLUDE in entity metadata, so a synchronize-built schema omits it).
--   3. TENANT ISOLATION — an appointment whose branch, customer or staff
--      belongs to a different tenant than the row itself. The most severe
--      possible outcome of a concurrent multi-tenant run.
--   4. ORPHANS          — child rows whose parent is gone, and appointments
--      missing the status-log / history rows the create path must write.
--   5. STATUS           — rows in a state the create path never produces.
--   6. QUOTA COUNTERS   — usage counters vs the rows actually present.
--   7. EXTERNAL EFFECTS — any row in a table that could cause an outbound send.
--      Expected count: ZERO, always.
-- ============================================================================

\pset pager off
\echo '--- 1. DOUBLE BOOKING (expected: 0) ---'
SELECT count(*) AS overlapping_active_pairs
  FROM appointments a
  JOIN appointments b
    ON a."staffId" = b."staffId" AND a.id < b.id
   AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
   AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
   AND tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)');

\echo '--- 1b. DOUBLE BOOKING among rows THIS SUITE created (expected: 0) ---'
SELECT count(*) AS overlapping_k6_pairs
  FROM appointments a
  JOIN appointments b
    ON a."staffId" = b."staffId" AND a.id < b.id
   AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
   AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
   AND tstzrange(a.start_at, a.end_at, '[)') && tstzrange(b.start_at, b.end_at, '[)')
 WHERE a.notes = 'k6-load-test' AND b.notes = 'k6-load-test';

\echo '--- 2. DOUBLE-BOOKING GUARD INSTALLED (expected: 1 row) ---'
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint WHERE conname = 'appointments_no_overlap';

\echo '--- 3. TENANT ISOLATION of created rows (expected: 0 each) ---'
SELECT
  count(*) FILTER (WHERE b."tenantId" IS DISTINCT FROM a."tenantId") AS branch_tenant_mismatch,
  count(*) FILTER (WHERE c."tenantId" IS DISTINCT FROM a."tenantId") AS customer_tenant_mismatch,
  count(*) FILTER (WHERE s."tenantId" IS DISTINCT FROM a."tenantId") AS staff_tenant_mismatch,
  count(*)                                                            AS k6_rows_checked
  FROM appointments a
  LEFT JOIN branches       b ON b.id = a."branchId"
  LEFT JOIN customers      c ON c.id = a."customerId"
  LEFT JOIN staff_profiles s ON s.id = a."staffId"
 WHERE a.notes = 'k6-load-test';

\echo '--- 4. ORPHANS / MISSING CHILD ROWS (expected: 0 each) ---'
SELECT
  (SELECT count(*) FROM appointment_services x
     LEFT JOIN appointments a ON a.id = x."appointmentId" WHERE a.id IS NULL) AS orphan_appt_services,
  (SELECT count(*) FROM appointment_status_logs x
     LEFT JOIN appointments a ON a.id = x."appointmentId" WHERE a.id IS NULL) AS orphan_status_logs,
  (SELECT count(*) FROM appointment_history x
     LEFT JOIN appointments a ON a.id = x."appointmentId" WHERE a.id IS NULL) AS orphan_history,
  -- The create path writes one status log and one history row inside the same
  -- transaction as the appointment; a row without them means a partial commit.
  (SELECT count(*) FROM appointments a WHERE a.notes = 'k6-load-test'
     AND NOT EXISTS (SELECT 1 FROM appointment_status_logs l WHERE l."appointmentId" = a.id)) AS k6_missing_status_log,
  (SELECT count(*) FROM appointments a WHERE a.notes = 'k6-load-test'
     AND NOT EXISTS (SELECT 1 FROM appointment_history h WHERE h."appointmentId" = a.id))     AS k6_missing_history,
  (SELECT count(*) FROM appointments a WHERE a.notes = 'k6-load-test'
     AND (a."tenantId" IS NULL OR a."branchId" IS NULL
          OR a."customerId" IS NULL OR a."staffId" IS NULL))                                  AS k6_null_fk;

\echo '--- 5. STATUS DISTRIBUTION of created rows (expected: CONFIRMED / IN_PROGRESS only) ---'
SELECT status, count(*) FROM appointments WHERE notes = 'k6-load-test' GROUP BY status ORDER BY 2 DESC;

\echo '--- 6. QUOTA COUNTERS vs reality, top 5 tenants by k6 volume ---'
-- `subscription_usage` is the row the booking transaction takes its admission
-- lock on (UsageService.incrementIfWithinLimit). Its `used` for the APPOINTMENTS
-- metric must move by exactly the number of rows the run committed — a counter
-- that ran ahead would mean an increment survived a rolled-back insert, and one
-- that lagged would mean a booking escaped the quota gate entirely.
SELECT t.slug,
       count(a.id) AS k6_appointments,
       COALESCE((SELECT sum(su.appointments_used) FROM subscription_usage su
                  WHERE su.tenant_id = t.id::text), 0) AS appointments_used_counter
  FROM appointments a
  JOIN tenants t ON t.id = a."tenantId"
 WHERE a.notes = 'k6-load-test'
 GROUP BY t.slug, t.id ORDER BY 2 DESC LIMIT 5;

\echo '--- 7. EXTERNAL SIDE-EFFECT SURFACE (expected: 0 everywhere) ---'
SELECT
  (SELECT count(*) FROM notification_rules)                        AS notification_rules,
  (SELECT count(*) FROM webhook_endpoints)                         AS webhook_endpoints,
  (SELECT count(*) FROM workflows)                                 AS workflows,
  (SELECT count(*) FROM whatsapp_accounts WHERE access_token <> '') AS live_whatsapp_accounts,
  (SELECT count(*) FROM scheduled_notifications
     WHERE created_at > now() - INTERVAL '2 hours')                AS recent_scheduled_notifications,
  (SELECT count(*) FROM payments  WHERE created_at > now() - INTERVAL '2 hours') AS recent_payments,
  (SELECT count(*) FROM payment_links WHERE created_at > now() - INTERVAL '2 hours') AS recent_payment_links;

\echo '--- 8. TOTALS ---'
SELECT (SELECT count(*) FROM appointments)                              AS appointments_total,
       (SELECT count(*) FROM appointments WHERE notes = 'k6-load-test') AS appointments_k6,
       (SELECT count(*) FROM api_logs)                                  AS api_logs,
       pg_size_pretty(pg_database_size(current_database()))             AS db_size;
