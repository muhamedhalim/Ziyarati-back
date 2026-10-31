# MFA rollout and rollback (approved policy)

Status: **prepared, NOT enforced.** Nothing below is switched on until `MFA_ENFORCE_FROM` /
`MFA_ENFORCE_CLINICAL_FROM` are set in production.

## Policy

| Tier | Roles | Enforced from | Behaviour once enforced |
|---|---|---|---|
| 1 privileged | `super_admin`, `platform_support`, `platform_sales`, any tenant-less (platform) user, clinic `owner`, `manager`, `branch_manager` | `MFA_ENFORCE_FROM` | No session until a factor is enrolled (login returns `mfaEnrollmentRequired`) |
| 2 clinical | `doctor`, `nurse`, and anyone holding `clinical.records.read/manage/nursing` | `MFA_ENFORCE_CLINICAL_FROM` | Same |
| none | patients (`customer`), receptionists without clinical access, `ai-bot` | never | Optional. An enrolled patient is still challenged at login; nobody else is prompted |

Source of truth: `src/modules/auth/mfa/mfa-policy.ts` (unit-tested per role). Unset or unparsable
dates mean "never enforced", so a typo cannot lock anyone out.

## What enforcement does (verified in code and scratch e2e)

- **Login:** enrolled user -> challenge, no cookies until the code is right. Mandatory but unenrolled
  user -> enrolment challenge, no cookies until the first code is confirmed (then 10 one-time recovery
  codes are shown once).
- **Refresh:** a session whose owner must hold a factor and has none cannot rotate; its token family is
  revoked and the client falls back to login (which walks them through enrolment). Access tokens already
  minted live out their short TTL.
- **Enrolment, disable and admin reset revoke every session of that user.**
- **Mandatory users cannot disable MFA** (403). Self-service disable stays available to everyone else.
- **Step-up guard** (`MFA_STEP_UP_ENABLED=true`, money-moving platform actions) now fails closed for a
  mandatory user who has no factor. Keep it OFF until the platform UI is confirmed to prompt (the dialog
  exists in the frontend: `MfaStepUpDialog`).

## Preconditions (all must hold before setting a date)

1. **Backend deployed** with `mfa-policy.ts` (this change) - verify ECS image contains the commit, and
   `POST /api/v1/auth/mfa/verify` with a garbage token returns 401.
2. **Frontend deployed** with the MFA step. Verified 2026-10-31: the live login bundle contains
   `auth/mfa/enroll/start`, `auth/mfa/verify` and `mfaEnrollmentRequired`. Re-check after any frontend deploy.
3. **At least two super admins exist**, so one can reset the other (`POST /auth/mfa/admin-reset/:userId`;
   self-reset is refused on purpose). If only one exists, create the second first.
4. **Every super admin / platform staff member has enrolled voluntarily** (`POST /auth/mfa/setup/start`
   then `/setup/confirm`) and stored their recovery codes offline. The enrolment itself ends their other
   sessions - sign in again afterwards. Confirm by logging in once more and receiving a code prompt.
5. **Support has the procedure** (below) for a lost device.
6. **Date is in the future** with a buffer (3+ days) so users see the prompt coming; communicate it.

Suggested order: Tier 1 first (platform staff are covered by precondition 4; owners get the forced
enrolment screen at their next login after the date), observe a week, then Tier 2.

## Applying (needs a human with Terraform apply rights)

1. In `infra/terraform/environments/production/terraform.tfvars`, uncomment `MFA_ENFORCE_FROM`
   (and later add `MFA_ENFORCE_CLINICAL_FROM`) with the agreed UTC date.
2. **Plan first and read it.** On 2026-10-31 a plan targeted at `module.platform.module.ecs` also pulled in
   (a) an in-place RDS instance/parameter-group update (`apply_immediately`, `rds.force_ssl` parameter
   re-ordering), (b) replacement of the api/worker/migrate task definitions adding the `TAP_LIVE_SECRET_KEY`
   and `TAP_MERCHANT_ID` secret references and the `AI_*` flags. Do **not** apply that as-is: reconcile the
   RDS drift and the Tap rollout step separately, or apply only once the plan shows nothing but the
   intended env changes. The RDS must stay Single-AZ and its availability settings untouched.
3. **Apply does NOT restart anything**: the ECS services ignore `task_definition` changes (`modules/ecs/main.tf` lifecycle). Apply only registers a new revision; the NEXT run of `deploy-aws.yml` clones the latest revision (`ecs-deploy.sh`) and rolls it. Verify the new revision contains the variable, then deploy (reviewer approval is the human gate).

## Verify after enforcement

- A test Tier-1 account without a factor receives `mfaEnrollmentRequired` and **no** `Set-Cookie`.
- An enrolled account receives `mfaRequired` and no cookies until `/auth/mfa/verify` succeeds.
- A patient login is unchanged (200 with cookies, no prompt).
- API 5xx and login-failure alarms stay flat for 24 h.

## Rollback

Fast (minutes): remove (comment out) the date line(s) and re-apply the same reviewed, targeted plan; ECS
rolls tasks and logins stop forcing enrolment. Users who already enrolled keep being asked for their code.
Nothing is deleted.

## Lost device

1. Has recovery codes -> user signs in with a recovery code (each works once), then re-enrols.
2. No codes -> **another** super admin calls `POST /auth/mfa/admin-reset/:userId` (audited as
   `platform_admin.mfa.reset`; ends the target's sessions; the target re-enrols at next login).
3. Sole super admin, no device, no codes -> roll back the enforcement date (above) so the password path
   works again, then use the ECS `psql` task family (`zt-production-psql`) to delete that user's
   `user_mfa` and `user_mfa_recovery_codes` rows under change control, and re-enrol. Do this only after
   identity is verified out of band. Avoid reaching this state by following precondition 3.
