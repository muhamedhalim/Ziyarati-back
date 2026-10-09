# DNS cutover: Railway → AWS (clean deployment) — PREPARED, NOT EXECUTED

Status 2026-10-08. `api.ziyaratech.com` still points to Railway. Railway holds **no real production data** (owner-confirmed),
so there is no data migration, no write freeze and no customer-visible downtime beyond DNS propagation (TTL 60 s).

## Facts (verified 2026-10-08)

| Item | Current | Target |
|---|---|---|
| `api.ziyaratech.com` | `CNAME wet4n3ld.up.railway.app.` (TTL 60) — **write this down for rollback** | `CNAME zt-production-api-1461747647.eu-central-1.elb.amazonaws.com.` |
| Certificate | — | ACM `ISSUED` for `api.ziyaratech.com` (CAA `amazon.com` added) |
| DNS host | Vercel DNS (`ns1/ns2.vercel-dns.com`) | same; change the existing `api` record's value (a name cannot hold CNAME + another record) |
| AWS stack | API 2/2, worker 1/1, image `sec-d3af6aa-1` (scan: 0 findings), ALB targets healthy | |
| Cookies | Railway: cross-site (`*.up.railway.app`) | AWS sets `COOKIE_DOMAIN=ziyaratech.com` (SameSite=Lax, Secure, HttpOnly) |

## Gates — everything in this table must be GREEN before the flip

| # | Gate | State 2026-10-08 |
|---|---|---|
| 1 | Hardened image deployed, scan clean | ✅ done |
| 2 | Auth, CRUD, RBAC, tenant isolation, S3, Redis, worker, Socket.IO validated on the ALB | ✅ done (see report) |
| 3 | **A real platform super-admin exists** (nothing can be approved without one — new clinics start `PENDING_VERIFICATION`) | ✅ created 2026-10-08 via the one-off seed task (below); login + clinic approval verified on the ALB. **Owner still has to**: read the one-time password from the temporary secret `zt/production/bootstrap-super-admin-password`, change it at first login, then delete that secret |
| 4 | SES: DNS records added (DKIM ×3, MAIL FROM MX+TXT, DMARC), identity `VERIFIED`, **production access** granted, then re-test a welcome email to a real inbox | ❌ pending (sandbox: 200/day, domain unverified) |
| 5 | SNS alert subscription `alerts@ziyaratech.com` confirmed | ❌ PendingConfirmation |
| 6 | Billing posture decided: `subscription_plans` is empty; platform billing mode defaults to FREE. Super-admin sets plans / mode in the console before onboarding paying clinics | ❌ owner decision |
| 7 | Meta (WhatsApp) webhook URL → `https://api.ziyaratech.com/api/v1/whatsapp/webhooks/events` (same verify token) — only if WhatsApp is live today | ⬜ owner |
| 8 | Tap stays OFF (`TAP_*_ENABLED=false`, no live key) until its own rollout step | ✅ intentional |
| 9 | Vercel env prepared (below) | ⬜ owner |
| 10 | Optional hardening: `EDGE_PROXY_TOKEN` (shared secret Vercel→API) so per-user throttling works behind the proxy | ⬜ recommended |

### Create the real super-admin (gate 3) — one-off task, project's standard seed
Run `node dist/src/seed/seed.js` as a one-off task on the `zt-production-migrate` definition with `ADMIN_EMAIL` and `ADMIN_PASSWORD`
supplied for that run only (command: `sh -c 'DATABASE_URL="${DATABASE_URL}?sslmode=require" NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem node dist/src/seed/seed.js'`).
It is idempotent, never overwrites an existing password, and skips the admin when the two variables are unset. Prefer a one-time
password that is changed on first login; the value is visible in the task's overrides (CloudTrail), so do not reuse a real password.

## Cutover (≈10 min, reversible in ≈1 min)

1. **Vercel env (www / book projects):** `BACKEND_ORIGIN=https://api.ziyaratech.com` (usually already this), `NEXT_PUBLIC_WS_URL=https://api.ziyaratech.com`.
   `NEXT_PUBLIC_*` is inlined at build → **redeploy** and wait for READY. (Order matters only for the WS URL; the REST proxy follows DNS.)
2. **DNS:** in Vercel DNS edit the existing `api` CNAME → `zt-production-api-1461747647.eu-central-1.elb.amazonaws.com` (keep TTL 60).
3. Wait ≤ 2 min, then verify from a machine with no overrides:
   ```bash
   dig +short api.ziyaratech.com                      # -> the ALB name / its IPs, not railway
   curl -s https://api.ziyaratech.com/api/v1/system/health/readiness   # db up, redis up, schemaGuards 42/42
   curl -sI http://api.ziyaratech.com | head -1                         # 301 -> https
   ```
4. Smoke in a browser on `https://www.ziyaratech.com`: sign in as the super-admin → create/approve a clinic → clinic owner sign-in → create a
   customer → upload a file → open the AI chat (WebSocket connects) → sign out. Watch CloudWatch (`/ziyaratech/production/api`, `/worker`) and the ALB 5xx alarm for 30 min.
5. Meta / Tap webhook URLs (gate 7 / 8) now, if applicable.

## Rollback (≈1 min, no data to reconcile — AWS has no customer data yet)

1. Vercel DNS: set `api` back to `CNAME wet4n3ld.up.railway.app.` (TTL 60 → effective in ~1–2 min).
2. Vercel env back to the previous values + redeploy.
3. Webhooks back to the Railway URLs. Leave AWS running (it is idle without traffic) or scale it down — never delete.
Keep Railway untouched for 14 days after a successful cutover.

## After cutover (not blockers)
- Switch WAF `count` → `block` after 14 clean days (`terraform.tfvars` `waf_mode`).
- Set GitHub Environments/variables so `deploy-aws.yml` can deploy (OIDC roles already exist); the CI build step already uses `--provenance=false --sbom=false`.
- Align `image_tag` in tfvars with the deployed tag **in the same change that registers new task definitions** (a tag change makes Terraform replace the task-definition revisions).
- Back up `infra/terraform/bootstrap/terraform.tfstate` (local state, git-ignored).
