-- MFA readiness (READ-ONLY). Run via the ops task zt-production-psql (default_transaction_read_only=on).
-- Prints masked identities + booleans/counts only. Never selects secret_enc, password_hash or recovery hashes.
\echo '== platform staff (tenant-less) MFA status'
SELECT left(u.id::text, 8)                                  AS user,
       regexp_replace(coalesce(u.email,''), '(^.).*(@.*$)', '\1***\2') AS email_masked,
       coalesce(string_agg(DISTINCT r.slug, ','), '-')      AS roles,
       u.is_active                                          AS active,
       coalesce(m.enabled, false)                           AS mfa_enabled,
       (SELECT count(*) FROM user_mfa_recovery_codes c
         WHERE c.user_id = u.id AND c.used_at IS NULL)      AS unused_recovery_codes
  FROM users u
  LEFT JOIN user_roles ur ON ur."userId" = u.id
  LEFT JOIN roles r       ON r.id = ur."roleId"
  LEFT JOIN user_mfa m    ON m.user_id = u.id
 WHERE u."tenantId" IS NULL AND u.deleted_at IS NULL
 GROUP BY u.id, u.email, u.is_active, m.enabled
 ORDER BY roles, user;

\echo '== gate: active super admins and how many are enrolled'
SELECT count(DISTINCT u.id)                                        AS active_super_admins,
       count(DISTINCT u.id) FILTER (WHERE m.enabled)               AS enrolled
  FROM users u
  JOIN user_roles ur ON ur."userId" = u.id
  JOIN roles r       ON r.id = ur."roleId" AND r.slug = 'super_admin'
  LEFT JOIN user_mfa m ON m.user_id = u.id
 WHERE u.is_active AND u.deleted_at IS NULL;

\echo '== tier-1 clinic users (owner/manager/branch_manager): counts only'
SELECT r.slug, count(DISTINCT u.id) AS users, count(DISTINCT u.id) FILTER (WHERE m.enabled) AS enrolled
  FROM users u
  JOIN user_roles ur ON ur."userId" = u.id
  JOIN roles r       ON r.id = ur."roleId" AND r.slug IN ('owner','manager','branch_manager')
  LEFT JOIN user_mfa m ON m.user_id = u.id
 WHERE u.is_active AND u.deleted_at IS NULL
 GROUP BY r.slug;
