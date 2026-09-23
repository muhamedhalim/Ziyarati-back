-- ============================================================================
-- INCIDENT 2026-09 — raw credential tokens used as email idempotency keys
-- 01: READ-ONLY ASSESSMENT. Outputs COUNTS AND STATUSES ONLY — never a token,
--     hash, key, address or id.
--
-- Background: before commit 6115b9c, EmailService built idempotency keys as
-- `invite:<rawToken>` / `reset:<rawToken>` / `verify:<rawToken>`. The key was
-- stored in email_logs.idempotency_key, became the BullMQ job id (Redis key
-- names) and was printed by QueueService ("enqueued email.send job=…").
-- After the fix the key is `<prefix>:sha256(rawToken)`.
--
-- password_resets stores ONLY sha256(rawToken) as token_hash (hex), so for a
-- 64-hex key tail T:
--   * post-fix (hashed) key   ⇔  T              = token_hash
--   * pre-fix (RAW, leaked)   ⇔  sha256(T)      = token_hash
--   * neither                 ⇔  row purged (AUTH_TOKEN_RETENTION_DAYS=7 after
--                                expiry) ⇒ token long expired ⇒ harmless.
--
-- Run:  psql "$URL" -v ON_ERROR_STOP=1 -f 01_readonly_assessment.sql
-- ============================================================================
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';

-- 1. Every email_logs row whose key embeds a credential-token-derived tail.
WITH k AS (
  SELECT
    e.id,
    e.template,
    e.status,
    split_part(e.idempotency_key, ':', 1) AS prefix,
    split_part(e.idempotency_key, ':', 2) AS tail
  FROM email_logs e
  WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
),
c AS (
  SELECT
    k.*,
    raw_pr.id    AS raw_pr_id,
    hashed_pr.id AS hashed_pr_id
  FROM k
  LEFT JOIN password_resets raw_pr
    ON raw_pr.token_hash = encode(sha256(convert_to(k.tail, 'UTF8')), 'hex')
  LEFT JOIN password_resets hashed_pr
    ON hashed_pr.token_hash = k.tail
)
SELECT
  prefix,
  template,
  CASE
    WHEN raw_pr_id IS NOT NULL    THEN 'RAW_TOKEN (leaked, row exists)'
    WHEN hashed_pr_id IS NOT NULL THEN 'HASHED (post-fix, safe)'
    WHEN tail ~ '^[0-9a-f]{64}$'  THEN 'UNMATCHED 64-hex (row purged => expired >7d)'
    ELSE 'OTHER'
  END AS classification,
  status AS email_status,
  count(*)::int AS n
FROM c
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- 2. State of every password_resets row whose RAW token was stored in email_logs.
SELECT
  CASE
    WHEN pr.used_at IS NOT NULL       THEN 'USED (consumed, cannot be replayed)'
    WHEN pr.expires_at <= now()       THEN 'EXPIRED (unusable)'
    ELSE 'ACTIVE — LEAKED AND STILL USABLE'
  END AS token_state,
  split_part(e.idempotency_key, ':', 1) AS prefix,
  count(*)::int AS n,
  min(pr.expires_at) AS earliest_expiry,
  max(pr.expires_at) AS latest_expiry
FROM email_logs e
JOIN password_resets pr
  ON pr.token_hash = encode(sha256(convert_to(split_part(e.idempotency_key, ':', 2), 'UTF8')), 'hex')
WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
GROUP BY 1, 2
ORDER BY 1, 2;

-- 3. All password_resets by state (context: how many tokens exist at all).
SELECT
  CASE
    WHEN used_at IS NOT NULL   THEN 'USED'
    WHEN expires_at <= now()   THEN 'EXPIRED'
    ELSE 'ACTIVE'
  END AS token_state,
  count(*)::int AS n,
  min(created_at) AS first_created,
  max(created_at) AS last_created
FROM password_resets
GROUP BY 1
ORDER BY 1;

-- 4. ACTIVE tokens NOT tied to any raw email_logs key. These were issued but
--    never logged raw by the email pipeline (e.g. issued after the fix) and
--    must be PRESERVED by remediation.
SELECT count(*)::int AS active_tokens_not_leaked_via_email_logs
FROM password_resets pr
WHERE pr.used_at IS NULL
  AND pr.expires_at > now()
  AND NOT EXISTS (
    SELECT 1 FROM email_logs e
    WHERE split_part(e.idempotency_key, ':', 1) IN ('invite', 'reset', 'verify')
      AND encode(sha256(convert_to(split_part(e.idempotency_key, ':', 2), 'UTF8')), 'hex') = pr.token_hash
  );

-- 5. Other secret-bearing columns — email_logs.metadata must not hold
--    token/url/password keys (EmailDeliveryService.safeMeta strips them).
SELECT count(*)::int AS email_logs_metadata_with_sensitive_keys
FROM email_logs
WHERE metadata IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM jsonb_object_keys(metadata::jsonb) k
    WHERE k ~* '(token|url|password|secret|code|otp)'
  );

-- 6. audit_logs — do any rows carry token/url-shaped keys in old/new values?
SELECT count(*)::int AS audit_rows_with_token_like_keys
FROM audit_logs
WHERE (old_values::text ~* '"(token|raw_token|reset_token|invitation_url|reset_url)"'
    OR new_values::text ~* '"(token|raw_token|reset_token|invitation_url|reset_url)"');

ROLLBACK;
