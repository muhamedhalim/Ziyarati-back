# MFA_ENFORCE_FROM - Terraform change plan (PREPARED, NOT APPLIED)

Plan date 2026-11-01. Read-only `terraform plan -lock=false -target=module.platform.module.ecs`, with
`TF_VAR_account_id`/`TF_VAR_image_tag` set (tag = the deployed `ad350ff...`; the tfvars default `bootstrap` must never be used).
Nothing applied. RDS Single-AZ, untouched.

## The MFA-only change (exact diff)
`terraform.tfvars` (uncomment one line inside `app_environment`, line ~117):
```diff
-  # MFA_ENFORCE_FROM = "2026-11-08T00:00:00Z"
+  MFA_ENFORCE_FROM = "2026-11-08T00:00:00Z"   # date is a placeholder - choose 3+ days ahead
```
Effect in the plan: one added env entry in each of three resources
(`module.platform.module.ecs.aws_ecs_task_definition.{api,worker,migrate}`):
```diff
+ { name = "MFA_ENFORCE_FROM", value = "2026-11-08T00:00:00Z" },
```
Comparing the plan with and without the line shows this is the ONLY difference (3 add / 2 change / 3 destroy both ways).

## Pre-existing drift in the same plan (not caused by MFA)
Baseline plan (MFA still commented) is already `3 to add, 2 to change, 3 to destroy`:
| Item | Resource | Nature |
|---|---|---|
| `AI_MINIMIZER_ENABLED=true`, `AI_VISION_ENABLED=false` | api/worker/migrate task defs | repo tfvars ahead of the TF-registered revision |
| `APP_ENV=production` (worker, migrate), `UPLOAD_MAX_BYTES=10485760` | task defs | same |
| `AUTH_REGISTER_OWNER_ENDPOINT_CEILING` 1000 -> 60 | task defs | owner-approved 2026-10-22 (tfvars:96) |
| `EMAIL_PROVIDER=ses` removed from env | task defs | tfvars/module no longer sets it; live `:41` still has it; checked: `env.validation.ts:1636-1641` accepts only `ses` and says to unset it, so removal is safe |
| `TAP_LIVE_SECRET_KEY`, `TAP_MERCHANT_ID` secret refs | api/worker task defs | already present in live `:41`; TF state is behind live |
| `tmp` volume replaced | task defs | cosmetic re-create |
| RDS `apply_immediately` true -> false | `module.rds.aws_db_instance.this` (pulled in by the target) | in-place, flag only; **no Multi-AZ/availability/class change** |
| `rds.force_ssl` parameter removed + re-added, same value `1` | `module.rds.aws_db_parameter_group.this` | ordering churn, no-op in effect |

Secret-key check (names only, earlier): `TAP_LIVE_PUBLIC_KEY` and `TAP_WEBHOOK_SECRET` are not in the secret; neither is referenced by the plan or by live `:41`.

## Why the targeted plan cannot isolate MFA
The MFA variable and the drift live in the SAME three task-definition resources, and the RDS pair is pulled in as a dependency of `-target=...ecs`. `-target` cannot split attributes of one resource. Applying it therefore ships all drift above into the new task-definition revisions (and pulls the RDS pair in).

## Important behaviour of ECS here (corrects the earlier runbook wording)
- Services have `ignore_changes = [task_definition, desired_count]`: **apply restarts nothing.** It registers new revisions and deregisters the ones in TF state.
- `ecs-deploy.sh` clones the family's latest ACTIVE revision, swapping the image. So the next deploy picks up the new revision, drift and MFA var included, and that deploy is what rolls the tasks (behind the production reviewer approval).
- Rollback: comment the line, re-plan/apply, deploy again.

## Options (your decision)
A. **Reconcile, then ship (recommended).** Review each drift row (`EMAIL_PROVIDER` removal checked and safe), accept or fix them in the repo, re-plan until the baseline plan is clean for ECS, then stage only the MFA line.
B. **Ship the drift together with MFA.** Acceptable if every row is intended; the plan above is the exact content.
C. **Out-of-band single env var** (register a revision cloned from live `:41` plus `MFA_ENFORCE_FROM`): isolates MFA completely but creates new TF drift and bypasses the IaC review; not recommended.
Use `-target` only with the RDS pair acknowledged; never a full-root plan/apply.

---

## Route A update (2026-11-01): classification and split plans

### Narrower target (removes the RDS pair)
Target the three task definitions, not the module:
```
terraform plan -lock=false -input=false \
  -target=module.platform.module.ecs.aws_ecs_task_definition.api \
  -target=module.platform.module.ecs.aws_ecs_task_definition.worker \
  -target=module.platform.module.ecs.aws_ecs_task_definition.migrate
# with TF_VAR_account_id=<account>  TF_VAR_image_tag=ad350ff8a5140859cf980abfb8a1d2df6db0a180  (never "bootstrap")
```
Result: **3 to add, 0 to change, 3 to destroy** - no RDS resource in the plan (the parameter group and instance
`apply_immediately` entries came only from `-target=...module.ecs`). RDS remains untouched, Single-AZ.

### Why state is behind
Terraform state still points at api task-definition revision **:20**. Live is **:41** (created by `ecs-deploy.sh`, which clones
the latest revision and swaps the image). Services ignore task-definition changes, so state never advanced.

### Drift classification (repo/tfvars vs. live `:41`)
| # | Item | Class | Evidence | Needs |
|---|---|---|---|---|
| 1 | `ENABLE_INTEGRATION_DOCS`: tfvars `"false"`, **live `:41` = `true`** | **Decision** | live-only change made outside Terraform; any deploy cloned from a TF revision silently turns it off | Keep public integration docs on in production? If yes, set tfvars to `"true"`; if no, accept `false` and tell whoever relies on it |
| 2 | `AI_MINIMIZER_ENABLED=true`, `AI_VISION_ENABLED=false` | Intentional | tfvars, commit `93148f8`; data-minimiser is the Saudi-residency control | Confirm go-live of the minimiser (a behaviour change on AI traffic) |
| 3 | `AUTH_REGISTER_OWNER_ENDPOINT_CEILING` 1000 -> 60 | Intentional | tfvars:96, owner-approved 2026-10-22 (RL-07) | none |
| 4 | `UPLOAD_MAX_BYTES=10485760` | Intentional | `modules/platform/main.tf:29`, commit `3479217` (2026-10-25) | none |
| 5 | `APP_ENV=production` on worker/migrate; api already had it in r20 but **live `:41` lacks it** | Intentional | `modules/platform/main.tf:17` (log `env` field) | none |
| 6 | `EMAIL_PROVIDER=ses` removed | Obsolete | commit `8fa7660` (2026-10-17); `env.validation.ts:1636-1641` accepts only `ses` and says to unset it | none (live `:41` still sets it; harmless) |
| 7 | `TAP_LIVE_SECRET_KEY`, `TAP_MERCHANT_ID` secret refs | Intentional, already live | present in `:41`; keys exist in the secret (checked by name earlier). `TAP_LIVE_PUBLIC_KEY`/`TAP_WEBHOOK_SECRET` are not referenced by the plan or `:41` | Separate Tap rollout step (runbook `tap-payments-rollout.md`) |
| 8 | `tmp` volume re-created, `hostPort`/`systemControls`/`volumesFrom` empties | Cosmetic | provider normalisation | none |
| 9 | RDS `apply_immediately` true -> false; `rds.force_ssl` remove/add (same value `1`) | Out of scope | only appear with `-target=module.ecs`; gone with the narrower target | Leave for a separate RDS review; not part of MFA |

### Smallest safe changes (prepared, NOT made)
- Only decision #1 may need a repo edit (`ENABLE_INTEGRATION_DOCS = "true"` if you want to keep it live). Nothing else needs editing: the repo is the intended state and the plan merely registers it.
- Two sequential applies, never combined, each followed by a deployment you approve:
  1. **Drift plan** (`drift-taskdefs.tfplan`): 3 add / 0 change / 3 destroy, no MFA entry.
  2. **MFA plan** (`mfa-taskdefs.tfplan`): identical plus `+ MFA_ENFORCE_FROM` in api, worker and migrate (verified by diffing the two plans).
  Because both replace the same three resources they cannot be applied as independent hunks; sequencing them is the separation.
- Apply registers revisions only; tasks change at the next `deploy-aws.yml` run (approval gate). The MFA date does nothing until that deploy.
