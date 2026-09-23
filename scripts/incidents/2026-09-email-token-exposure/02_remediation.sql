-- ============================================================================
-- INCIDENT 2026-09 — raw credential tokens used as email idempotency keys
-- 02: REMEDIATION. Transactional, narrowly scoped, idempotent.
--
--   DRY RUN (default — every change is ROLLED BACK):
--     psql "$URL" -v ON_ERROR_STOP=1 -f 02_remediation.sql
--   APPLY (only after reviewing the dry-run output):
--     psql "$URL" -v ON_ERROR_STOP=1 -v apply=1 -f 02_remediation.sql
--
-- Prints COUNTS ONLY. Never selects a token, hash, key, address or id.
--
-- What it does
--   A. password_resets: every token whose RAW value was stored in
--      email_logs.idempotency_key (so it was also printed in Railway logs and
--      used as a Redis key) AND is still usable → expires_at = now().
--      Row, token_hash, created_at and used_at are kept (audit). used_at is NOT
--      set: it means "consumed by the user", which did not happen. The staff
--      access status then derives as `invitation_expired`, which is exactly
--      what the clinic UI offers "Resend invitation" for.
--   B. email_logs: every idempotency_key whose tail is still a raw token is
--      replaced by 'redacted-<prefix>:' || sha256(tail). Template, status,
--      error, attempts, timestamps are kept. The 'redacted-' prefix can never
--      collide with a key the application generates, and the hash keeps each
--      value unique (the column is UNIQUE).
--
-- What it deliberately does NOT touch
--   * Tokens never logged raw (issued after commit 6115b9c) — preserved.
--   * Used / expired tokens — already unusable; left for the retention purge.
--   * Any row outside the two statements below.
--
-- Raw vs hashed: a post-fix key's tail IS a password_resets.token_hash; a
-- pre-fix key's tail is the raw token, whose sha256 is the token_hash (or whose
-- row was already purged, AUTH_TOKEN_RETENTION_DAYS after expiry). So "tail is
-- not a current token_hash" selects every raw key. Masking a stray hashed key
-- would be harmless (it holds no secret) — but none qualifies today.
--
-- Idempotent: after one apply, A finds no usable leaked token and B finds no
-- unmasked key, so a second run changes 0 rows.
--
-- Expected from the 2026-09-24 read-only assessment: A = 2, B = 7.
-- The guard aborts if either exceeds that — a larger number means something
-- changed since the assessment and must be reviewed first.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ── Targets (computed once, inside the transaction) ─────────────────────────
CREATE TEMP TABLE _leaked_active_tokens ON COMMIT DROP AS
SELECT DISTINCT pr.id
FROM password_resets pr
JOIN email_logs e
  ON pr.token_hash = encode(sha256(convert_to(split_part(e.idempotency_key, ':', 2), 'UTF8')), 'hex')
WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
  AND pr.used_at IS NULL
  AND pr.expires_at > now();

CREATE TEMP TABLE _raw_keys ON COMMIT DROP AS
SELECT e.id
FROM email_logs e
WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
  AND split_part(e.idempotency_key, ':', 2) ~ '^[0-9a-f]{64}$'
  AND NOT EXISTS (
    SELECT 1 FROM password_resets pr
    WHERE pr.token_hash = split_part(e.idempotency_key, ':', 2)
  );

SELECT
  (SELECT count(*) FROM _leaked_active_tokens) AS a_tokens_to_invalidate,
  (SELECT count(*) FROM _raw_keys)             AS b_keys_to_mask;

DO $$
DECLARE a int; b int;
BEGIN
  SELECT count(*) INTO a FROM _leaked_active_tokens;
  SELECT count(*) INTO b FROM _raw_keys;
  IF a > 2 OR b > 7 THEN
    RAISE EXCEPTION 'Target counts (tokens=%, keys=%) exceed the reviewed assessment (2, 7) — re-run 01_readonly_assessment.sql and review before applying', a, b;
  END IF;
END $$;

-- ── A. Invalidate leaked, still-usable tokens (keep the row + hash) ────────
UPDATE password_resets pr
SET expires_at = now()
FROM _leaked_active_tokens t
WHERE pr.id = t.id
  AND pr.used_at IS NULL
  AND pr.expires_at > now();

-- ── B. Mask raw tokens in email_logs keys (keep the row) ───────────────────
UPDATE email_logs e
SET idempotency_key =
      'redacted-' || split_part(e.idempotency_key, ':', 1) || ':' ||
      encode(sha256(convert_to(split_part(e.idempotency_key, ':', 2), 'UTF8')), 'hex')
FROM _raw_keys r
WHERE e.id = r.id;

-- ── Post-update verification (inside the same transaction) ─────────────────
DO $$
DECLARE still_usable int; still_raw int;
BEGIN
  SELECT count(*) INTO still_usable
  FROM password_resets pr
  JOIN email_logs e
    ON e.idempotency_key LIKE 'redacted-%'
   AND pr.token_hash = split_part(e.idempotency_key, ':', 2)
  WHERE pr.used_at IS NULL AND pr.expires_at > now();

  SELECT count(*) INTO still_raw
  FROM email_logs e
  WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
    AND split_part(e.idempotency_key, ':', 2) ~ '^[0-9a-f]{64}$'
    AND NOT EXISTS (SELECT 1 FROM password_resets pr
                    WHERE pr.token_hash = split_part(e.idempotency_key, ':', 2));

  IF still_usable > 0 OR still_raw > 0 THEN
    RAISE EXCEPTION 'Verification failed: % leaked token(s) still usable, % raw key(s) remain', still_usable, still_raw;
  END IF;
  RAISE NOTICE 'Verification passed: 0 leaked tokens usable, 0 raw keys remain';
END $$;

SELECT
  count(*) FILTER (WHERE used_at IS NULL AND expires_at > now()) AS active_tokens_remaining,
  count(*) AS password_reset_rows_total
FROM password_resets;
SELECT count(*) AS masked_email_log_keys
FROM email_logs WHERE idempotency_key LIKE 'redacted-%';

\if :apply
  COMMIT;
  \echo 'APPLIED (committed).'
\else
  ROLLBACK;
  \echo 'DRY RUN — rolled back. Re-run with -v apply=1 to commit.'
\endif
