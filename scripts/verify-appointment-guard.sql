-- ===========================================================================
-- P0.1 — PRODUCTION VERIFICATION: is the double-booking guard actually there?
--
-- STRICTLY READ-ONLY. No DDL, no DML, no locks beyond ordinary catalog reads.
-- Safe to run against a live production database at any time.
--
--   psql "$DATABASE_URL" -f scripts/verify-appointment-guard.sql
--
-- WHY THIS EXISTS: `appointments_no_overlap` is the ONLY race-safe barrier
-- against two concurrent bookings taking the same staff member and time. An
-- availability check followed by an INSERT cannot be race-safe under READ
-- COMMITTED. The constraint can be MISSING from a database whose `migrations`
-- table says it was applied — a TYPEORM_SYNCHRONIZE=true boot drops EXCLUDE
-- constraints it does not recognise, and leaves the migration row behind. So
-- the migrations table is NOT evidence; only line 1 below is.
--
-- HOW TO READ THE OUTPUT
--   1. GUARD          expect exactly one row. Zero rows = UNPROTECTED.
--   2. EXTENSION      btree_gist must be present for the guard to exist.
--   3. MIGRATIONS     both rows expected. Their presence proves nothing on
--                     its own — compare against (1).
--   4. CONFLICTS      expect 0. Any number > 0 means real double-bookings
--                     already exist and the guard cannot be installed until
--                     they are resolved.
--   5. VERDICT        one line, plain English.
--
-- If the verdict is UNPROTECTED: run `npm run migration:run`, which applies
-- AppointmentNoOverlapRepair1730088000000 (idempotent; aborts loudly rather
-- than deleting anything if conflicts exist). Note that installing the
-- constraint takes an ACCESS EXCLUSIVE lock and rebuilds a GiST index over
-- every live appointment — measured at ~15s for 900,000 rows — so bookings
-- block for that long. Use a maintenance window.
-- ===========================================================================
\pset pager off

\echo ''
\echo '=== 0. TARGET ============================================================='
SELECT current_database()               AS database_name,
       current_setting('server_version') AS postgres_version,
       now()                             AS checked_at;

\echo ''
\echo '=== 1. GUARD (the only real evidence) ====================================='
SELECT c.conname                     AS constraint_name,
       t.relname                     AS on_table,
       c.contype                     AS type_x_is_exclusion,
       c.convalidated                AS validated,
       pg_get_constraintdef(c.oid)   AS definition
  FROM pg_constraint c
  JOIN pg_class      t ON t.oid = c.conrelid
 WHERE c.conname = 'appointments_no_overlap';

\echo ''
\echo '=== 2. REQUIRED EXTENSION ================================================='
SELECT extname AS extension, extversion AS version
  FROM pg_extension
 WHERE extname = 'btree_gist';

\echo ''
\echo '=== 3. MIGRATION RECORD (informational only — NOT proof) =================='
-- On a database that has NEVER run migrations (built purely by synchronize)
-- this one query errors with `relation "migrations" does not exist`. That is
-- harmless and itself diagnostic: psql continues, and section 5 still reports
-- the verdict. Do not add ON_ERROR_STOP to this script.
SELECT id, timestamp, name
  FROM migrations
 WHERE name LIKE 'AppointmentNoOverlap%'
 ORDER BY timestamp;

\echo ''
\echo '=== 4. CONFLICTING APPOINTMENTS (must be 0 to install the guard) =========='
-- Exactly the predicate the constraint enforces: same staff, overlapping
-- half-open [start, end) window, ignoring cancelled/no-show and soft-deleted.
WITH pairs AS (
  SELECT a.id AS a_id, b.id AS b_id
    FROM appointments a
    JOIN appointments b
      ON a."staffId" = b."staffId"
     AND a.id < b.id
     AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
     AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
     AND tstzrange(a.start_at, a.end_at, '[)')
      && tstzrange(b.start_at, b.end_at, '[)')
),
involved AS (SELECT a_id AS id FROM pairs UNION SELECT b_id FROM pairs)
SELECT (SELECT count(*) FROM pairs)    AS overlapping_pairs,
       (SELECT count(*) FROM involved) AS appointments_involved,
       (SELECT count(DISTINCT ap."staffId")  FROM appointments ap JOIN involved i ON i.id = ap.id) AS staff_affected,
       (SELECT count(DISTINCT ap."tenantId") FROM appointments ap JOIN involved i ON i.id = ap.id) AS tenants_affected,
       (SELECT count(DISTINCT ap."branchId") FROM appointments ap JOIN involved i ON i.id = ap.id) AS branches_affected;

\echo ''
\echo '=== 5. VERDICT ============================================================'
SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
       WHERE c.conname = 'appointments_no_overlap' AND c.contype = 'x'
         AND t.relname = 'appointments')
      THEN 'UNPROTECTED — appointments_no_overlap is NOT installed. '
           || 'Concurrent bookings for the same staff and window can BOTH succeed '
           || '(HTTP 201 for every one of them). Run: npm run migration:run'
    WHEN EXISTS (
      SELECT 1 FROM appointments a JOIN appointments b
        ON a."staffId" = b."staffId" AND a.id < b.id
       AND a.status NOT IN ('CANCELLED','NO_SHOW') AND a.deleted_at IS NULL
       AND b.status NOT IN ('CANCELLED','NO_SHOW') AND b.deleted_at IS NULL
       AND tstzrange(a.start_at,a.end_at,'[)') && tstzrange(b.start_at,b.end_at,'[)'))
      THEN 'INCONSISTENT — the constraint reports as installed but overlapping rows '
           || 'exist. This should be impossible; investigate before trusting bookings.'
    ELSE 'PROTECTED — appointments_no_overlap is installed and no overlapping '
         || 'appointments exist.'
  END AS verdict;
\echo ''
