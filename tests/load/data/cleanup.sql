-- ============================================================================
-- Removes ONLY what the k6 write scenarios created.
-- ============================================================================
-- Write scenarios book real appointments. Because the list endpoint orders by
-- `start_at DESC`, those far-future rows sort ahead of the seeded data and
-- would change what a later READ scenario sees — so the dataset must be
-- restored between a write run and a read baseline, or the two are not
-- comparable.
--
-- Every row the suite creates carries notes = 'k6-load-test'. Nothing else in
-- the fixture or the perf seed uses that value, so this is exact: it can never
-- touch the 60,000 seeded appointments.
--
-- Run:
--   docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf \
--     -f /tmp/cleanup.sql
-- ============================================================================

BEGIN;

-- Child rows first (appointment_services has no ON DELETE CASCADE to appointments).
DELETE FROM appointment_services
 WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes = 'k6-load-test');

DELETE FROM appointment_status_logs
 WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes = 'k6-load-test');

DELETE FROM appointment_history
 WHERE "appointmentId" IN (SELECT id FROM appointments WHERE notes = 'k6-load-test');

DELETE FROM appointments WHERE notes = 'k6-load-test';

-- Guest records created by the public booking funnel, if BOOKING_CONFIRM was on.
DELETE FROM customers WHERE full_name LIKE 'Load Test Guest %';

COMMIT;

SELECT 'remaining k6 appointments' AS check, count(*) FROM appointments WHERE notes = 'k6-load-test'
UNION ALL
SELECT 'total appointments', count(*) FROM appointments;
