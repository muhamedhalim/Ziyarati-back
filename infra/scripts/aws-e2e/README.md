# AWS end-to-end smoke harness (built 2026-10-08)

Plain Node (no deps except the repo's `socket.io-client`). Pins `api.ziyaratech.com` to the ALB **in-process** (no DNS/hosts
changes), so it can test AWS while DNS still points at Railway. **Never use the XHR polling transport of socket.io-client in
this harness** — it ignores the pin and would hit the real DNS; `stage4b.cjs` uses the raw HTTPS client instead.

Run from this folder, in order (state is kept in `state.json`, admin credentials in `admin.json` — both git-ignored, delete after):

| Stage | What it proves |
|---|---|
| `stage1` | register 2 throwaway clinics (SES-simulator emails), cookie flags, CSRF, refresh rotation + replay rejection |
| `stage3` / `stage3b` | product onboarding: verification docs -> super-admin review -> clinic approval (needs a super-admin in `admin.json`: `{"email","password"}`) |
| `stage2` | RBAC, customer CRUD, tenant isolation, S3 upload/presign/delete, Redis rate-limit counters |
| `stage4b` | Socket.IO polling + stickiness + origin policy (WebSocket check was run with socket.io-client `transports:['websocket']`) |
| `stage5` | patient-file delete purges every S3 version (needs the `s3:DeleteObjectVersion` IAM fix) |
| `iso` | tenant list isolation by ID sets |
| `suspend` -> `node dist/src/tenant-offboard.js ...` | remove the test clinics with the product's own offboarding (dry-run first) |
| `deploy.cjs <tag> register` | CI-equivalent task-definition registration (image-only change) |

Test data uses `zz-e2e-*` slugs and `*@simulator.amazonses.com` addresses. Always offboard the clinics and delete the throwaway
super-admin afterwards; verify with `list-object-versions` on the uploads bucket and `SELECT count(*) FROM tenants`.
