-- ============================================================================
-- k6 LOAD-TEST FIXTURE  —  ziyarati_perf (T1) ONLY
-- ============================================================================
-- Closes the three data gaps in `perf-fixture.seed.ts` that would otherwise
-- make whole scenarios measure empty-table paths:
--
--   1. services            = 0 rows  -> /services empty; bookings can't use serviceIds
--   2. staff_schedules /
--      working_hours       = 0 rows  -> availability windows return nothing
--   3. audit_logs          = 182     -> activity log is effectively empty
--   4. every appointment sits in one week of Jan-2025 -> any ?from=today is empty
--
-- SAFETY: this script writes ONLY to the isolated perf database. It creates no
-- notification_rules, no webhook_endpoints, no workflows and no
-- whatsapp_accounts — the four tables whose emptiness is what structurally
-- guarantees a load test can trigger no external send. Do not add them here.
--
-- Idempotent: every statement is guarded, so re-running is a no-op.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. SERVICES — 8 per tenant, FIXED pricing (VARIABLE would 422 on booking).
-- ---------------------------------------------------------------------------
INSERT INTO services (id, name, description, duration_minutes, pricing_type, base_price, is_active, "tenantId")
SELECT
  uuid_generate_v4(),
  s.name,
  'Load-test fixture service',
  s.duration,
  'FIXED',
  s.price,
  true,
  t.id
FROM tenants t
CROSS JOIN (VALUES
  ('General Consultation', 30, 150.00),
  ('Follow-up Visit',      15,  80.00),
  ('Dental Cleaning',      45, 250.00),
  ('Dental Filling',       60, 400.00),
  ('Skin Assessment',      30, 200.00),
  ('Laser Session',        45, 600.00),
  ('Physiotherapy',        60, 300.00),
  ('Lab Panel',            15, 120.00)
) AS s(name, duration, price)
WHERE NOT EXISTS (SELECT 1 FROM services x WHERE x."tenantId" = t.id);

-- ---------------------------------------------------------------------------
-- 2. WORKING HOURS — per branch, 7 days, 08:00-20:00 (open every day).
--    day_of_week is smallint 0..6.
-- ---------------------------------------------------------------------------
INSERT INTO working_hours (id, day_of_week, start_time, end_time, is_closed, "branchId", "tenantId")
SELECT uuid_generate_v4(), d.dow, TIME '08:00', TIME '20:00', false, b.id, b."tenantId"
FROM branches b
CROSS JOIN generate_series(0, 6) AS d(dow)
WHERE NOT EXISTS (SELECT 1 FROM working_hours w WHERE w."branchId" = b.id);

-- ---------------------------------------------------------------------------
-- 3. STAFF SCHEDULES — every staff member works every day at their own branch.
--    Resolved through branch_users so each staff lands on a real branch.
-- ---------------------------------------------------------------------------
INSERT INTO staff_schedules (id, day_of_week, start_time, end_time, is_active, "staffId", "branchId", "tenantId")
SELECT uuid_generate_v4(), d.dow, TIME '08:00', TIME '20:00', true, sp.id, bu."branchId", sp."tenantId"
FROM staff_profiles sp
JOIN LATERAL (
  SELECT bu."branchId" FROM branch_users bu WHERE bu."userId" = sp.user_id LIMIT 1
) bu ON TRUE
CROSS JOIN generate_series(0, 6) AS d(dow)
WHERE NOT EXISTS (SELECT 1 FROM staff_schedules ss WHERE ss."staffId" = sp.id);

-- ---------------------------------------------------------------------------
-- 4. STAFF <-> SERVICES — so /services/available?staffId= returns rows.
-- ---------------------------------------------------------------------------
INSERT INTO staff_services (id, "staffId", "serviceId", "tenantId")
SELECT uuid_generate_v4(), sp.id, sv.id, sp."tenantId"
FROM staff_profiles sp
JOIN services sv ON sv."tenantId" = sp."tenantId"
WHERE NOT EXISTS (
  SELECT 1 FROM staff_services ss WHERE ss."staffId" = sp.id AND ss."serviceId" = sv.id
);

-- ---------------------------------------------------------------------------
-- 5. APPOINTMENT DATES — spread the single Jan-2025 week across ~6 months,
--    straddling today so `?from=<today>` and dashboard ranges return real rows.
--
--    CONSTRAINT SAFETY: appointments carry a gist EXCLUDE on
--    ("staffId", tstzrange(start_at, end_at)) for non-cancelled rows. Each row
--    is shifted by a constant base PLUS a whole number of weeks chosen by its
--    per-staff sequence number (k % 26):
--      - same residue  -> identical shift, and the rows were already >= 26
--        slots apart in time, so they stay apart;
--      - different residue -> shifts differ by >= 7 days, while the original
--        per-staff span is < 7 days, so they cannot collide.
--    Ordering within a staff member is therefore preserved and no new overlap
--    can be introduced.
-- ---------------------------------------------------------------------------
WITH seq AS (
  SELECT id,
         row_number() OVER (PARTITION BY "staffId" ORDER BY start_at) AS k
  FROM appointments
),
anchor AS (
  -- Map the earliest seeded appointment to 3 weeks from now, then the weekly
  -- spread below pulls rows backwards up to ~6 months.
  SELECT (date_trunc('day', now()) + INTERVAL '21 days') - MIN(start_at) AS base
  FROM appointments
)
UPDATE appointments a
SET start_at = a.start_at + anchor.base - ((seq.k % 26) * INTERVAL '7 days'),
    end_at   = a.end_at   + anchor.base - ((seq.k % 26) * INTERVAL '7 days')
FROM seq, anchor
WHERE a.id = seq.id
  -- Re-run guard: the seeded week sits in Jan-2025; every shifted row lands
  -- in 2026-03 or later, so this both selects the un-shifted data and makes a
  -- second run a no-op.
  AND a.start_at < TIMESTAMPTZ '2026-01-01'
;

-- ---------------------------------------------------------------------------
-- 6. AUDIT LOGS — ~1000 per tenant, spread over the last 180 days, so the
--    activity-log scenario exercises real pagination, COUNT and trigram search.
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (id, action, entity_type, entity_id, "tenantId", "userId", "branchId", entity_label, created_at)
SELECT
  uuid_generate_v4(),
  act.action,
  act.entity_type,
  uuid_generate_v4(),
  t.id,
  u.id,
  b.id,
  act.entity_type || ' #' || g.n,
  now() - (random() * INTERVAL '180 days')
FROM tenants t
JOIN LATERAL (SELECT id FROM users WHERE "tenantId" = t.id LIMIT 1) u ON TRUE
JOIN LATERAL (SELECT id FROM branches WHERE "tenantId" = t.id LIMIT 1) b ON TRUE
CROSS JOIN generate_series(1, 1000) AS g(n)
CROSS JOIN LATERAL (
  SELECT * FROM (VALUES
    ('appointment.created',   'Appointment'),
    ('appointment.updated',   'Appointment'),
    ('appointment.cancelled', 'Appointment'),
    ('customer.created',      'Customer'),
    ('customer.updated',      'Customer'),
    ('staff.updated',         'StaffProfile'),
    ('invoice.created',       'Invoice'),
    ('payment.recorded',      'Payment')
  ) v(action, entity_type)
  OFFSET floor(random() * 8) LIMIT 1
) act
WHERE (SELECT count(*) FROM audit_logs al WHERE al."tenantId" = t.id) < 100;

-- ---------------------------------------------------------------------------
-- 7. PUBLIC BOOKING ELIGIBILITY
--
--    The public funnel is fail-closed by design: PublicDiscoveryService requires
--    an APPROVED + active tenant AND `COALESCE(ts.public_booking_enabled,false)
--    = true`. The perf tenants are approved but have never opted in, so the
--    whole funnel returns empty without this. City taxonomy is likewise empty
--    (`cities` = 0 rows, every `branches.city_id` NULL), which makes the
--    city-first step of the funnel dead-end.
--
--    We opt in only the 5 tenants that have loggable users, so the remaining 46
--    stay opted-out and the discovery queries still have to filter — a
--    single-tenant-everything dataset would make that predicate free.
-- ---------------------------------------------------------------------------
INSERT INTO cities (id, name_ar, name_en)
SELECT uuid_generate_v4(), c.ar, c.en
FROM (VALUES
  ('الرياض', 'Riyadh'), ('جدة', 'Jeddah'), ('الدمام', 'Dammam'),
  ('مكة', 'Makkah'),   ('المدينة', 'Madinah')
) AS c(ar, en)
WHERE NOT EXISTS (SELECT 1 FROM cities);

-- Opt in the 5 primary tenants (those with real logins).
UPDATE tenant_settings ts
SET public_booking_enabled = true
FROM tenants t
WHERE ts.tenant_id = t.id
  AND t.slug IN ('perf-t1-tenant-0','perf-t1-tenant-1','perf-t1-tenant-2',
                 'perf-t1-tenant-3','perf-t1-tenant-4');

-- Spread branches of opted-in tenants across the cities, round-robin.
WITH ranked AS (
  SELECT b.id, row_number() OVER (ORDER BY b.id) AS rn
  FROM branches b
  JOIN tenant_settings ts ON ts.tenant_id = b."tenantId"
  WHERE ts.public_booking_enabled = true AND b.city_id IS NULL
),
city AS (SELECT id, row_number() OVER (ORDER BY name_en) - 1 AS idx FROM cities)
UPDATE branches b
SET city_id = city.id
FROM ranked, city
WHERE b.id = ranked.id
  AND city.idx = (ranked.rn % (SELECT count(*) FROM cities));

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
SELECT 'cities' AS table, count(*) FROM cities
UNION ALL SELECT 'public-booking tenants', count(*) FROM tenant_settings WHERE public_booking_enabled
UNION ALL SELECT 'branches with city', count(*) FROM branches WHERE city_id IS NOT NULL;

SELECT 'services'         AS table, count(*) FROM services
UNION ALL SELECT 'working_hours',   count(*) FROM working_hours
UNION ALL SELECT 'staff_schedules', count(*) FROM staff_schedules
UNION ALL SELECT 'staff_services',  count(*) FROM staff_services
UNION ALL SELECT 'audit_logs',      count(*) FROM audit_logs;

SELECT 'appointments in past'   AS bucket, count(*) FROM appointments WHERE start_at <  now()
UNION ALL
SELECT 'appointments in future', count(*) FROM appointments WHERE start_at >= now()
UNION ALL
SELECT 'appointments today',     count(*) FROM appointments
  WHERE start_at >= date_trunc('day', now()) AND start_at < date_trunc('day', now()) + INTERVAL '1 day';
