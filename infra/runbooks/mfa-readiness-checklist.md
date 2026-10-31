# MFA production readiness checklist

Companion to `mfa-rollout.md`. Nothing here is automated; every box needs a named human and a date.
No date variable (`MFA_ENFORCE_FROM`) may be applied until sections A-D are ticked.

## A. Platform admin inventory (read-only)
Run `infra/runbooks/sql/mfa-readiness.sql` through the existing read-only ops task `zt-production-psql`
(`default_transaction_read_only=on`). It prints masked emails, role slugs, booleans and counts only; it never
selects the TOTP seed, password hash or recovery-code hashes.
- [ ] Output saved to the evidence folder (no row contents beyond the masked output).
- [ ] Every platform user listed is a known, current employee. Unknown or stale accounts -> deactivate through
      change control (not part of this task).

## B. Two-Super-Admin requirement (hard gate)
- [ ] `active_super_admins` >= 2 (gate query).
- [ ] Both are different people with separate devices, not one person with two accounts.
- [ ] `enrolled` = `active_super_admins` (every super admin has a factor).
- [ ] A break-glass owner is named for the sole-super-admin DB procedure in `mfa-rollout.md` ("Lost device").

## C. Enrolment (each admin, by themselves)
1. Sign in at the normal login page. Because no date is set, the account gets a normal session.
2. Start setup (`POST /api/v1/auth/mfa/setup/start`), scan the QR/secret in an authenticator app, confirm with a code
   (`/setup/confirm`). **Confirming ends all of that user's other sessions** - sign in again.
3. Store the 10 recovery codes offline (password manager vault or printed, two locations). They are shown once.
4. Sign out, sign in again: a code prompt must appear. Record "prompted: yes/no" per admin - this is the production
   login verification; only the admin themselves performs it.
- [ ] Each admin confirmed steps 1-4 (self-reported + `user_mfa.enabled` true in the SQL output).
- [ ] Each admin has used ONE recovery code on a non-critical test? **No** - codes are single-use; instead confirm the
      other super admin can run `admin-reset` (documented, audited) rather than burning a code.

## D. Recovery
- [ ] Lost device with codes -> sign in with a code, then re-enrol.
- [ ] Lost device without codes -> the other super admin runs `POST /auth/mfa/admin-reset/:userId`.
- [ ] Sole-admin fallback rehearsed on paper only (roll back the date first, then DB rows under change control).
- [ ] Support has the procedure and verifies identity out of band before any reset.

## E. Platform preconditions
- [ ] Deployed image contains the policy (verified 2026-10-31: `ad350ff`).
- [ ] Frontend bundle supports `mfaEnrollmentRequired` (verified 2026-10-31).
- [ ] Terraform plan for the date shows ONLY the new env var (see `mfa-terraform-change.md`).
- [ ] Date is 3+ days ahead; clinic owners/managers notified (they are Tier 1 and will be forced to enrol at next login).
- [ ] Rollback owner and window agreed; RDS untouched, Single-AZ.

## F. After apply (verification by real login, by humans)
- [ ] Unenrolled Tier-1 test account: enrolment screen, no session until confirmed.
- [ ] Enrolled admin: code prompt.
- [ ] Patient login unchanged.
- [ ] API 5xx and login-failure alarms flat for 24 h.
