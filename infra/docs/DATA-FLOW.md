# Data flows

Residency plan section 6. One row per flow that moves personal data between systems, with what the **code** does about it today. It is a map, not an assessment: the legal columns (basis, mechanism) are in `PDPL-COMPLIANCE.md` and `TRANSFER-IMPACT-ASSESSMENT.md`, and every mechanism is **missing** until a document exists.

Status words: **built** (implemented and tested in this repository), **built, off** (implemented, default-off or needs a deployment setting), **open** (not built or not decided), `CV` (needs code verification), `VC` (needs vendor confirmation), `LC` (needs counsel), `OV` (needs official verification).

PD personal · SD sensitive identifiers · HD health · AU authentication · PY payment.

| # | Flow | Data | Leaves KSA | Processor (register id) | What the code does today | Status |
|---|---|---|---|---|---|---|
| F1 | Browser → Vercel (pages) | page requests, cookies (PD, AU) | yes | `vercel` | Static/public shell. Whether the authenticated shell may be served from Vercel is L14 | open, `LC` |
| F2 | Browser → Vercel → backend `/api/*` | **every REST body** (PD, SD, HD, AU, PY) | yes | `vercel` | Direct API routing: with `NEXT_PUBLIC_API_BASE_URL` set the browser calls the API host and no `/api` rewrite is registered (`Ziyarati-font/next.config.ts`, `app/lib/api/api-base.ts`). **Default is still the proxy until that variable is set in the deployment** | built, off |
| F3 | Browser → Vercel Analytics | URL paths, device data | yes | `vercel` | Mounted on public routes only (`app/components/analytics/PublicAnalytics.tsx`) | built; `CV` that public URLs carry no identifiers |
| F4 | Browser → backend WebSocket (AI chat) | chat turns (PD, HD) | depends on the API host's Region | host | Origin / Fetch-Metadata admission and guest room isolation (CSWSH remediation) | built; hosting open |
| F5 | Backend → PostgreSQL | system of record, embeddings | depends on the Region | `railway` now / `aws` planned | TLS (`verify-full`), env CMK, PITR 14 d planned | hosting decision open (L1/L2) |
| F6 | Backend → Redis / BullMQ | job payloads: recipient + variables (e-mail, WhatsApp), AI text | depends on the Region | same | PII redaction for jobs (`src/queue/job-pii-redaction.ts`); failed PII jobs kept 6 h; completed 1 h (`queue.constants.ts`). Queued payloads already in Redis are not rewritten | built; residual gap listed in `PDPL-COMPLIANCE.md` |
| F7 | Backend → object storage | patient documents, guest attachments (PD, SD, HD) | yes today (Cloudflare R2) | `cloudflare-r2` / `aws` | Env-CMK bucket, no replication, versioned, TLS-only (Terraform, tested). No lifecycle on current objects (L12) | built (IaC, not applied); data still on R2 |
| F8 | Backend → OpenAI chat | prompts, turns, tool arguments and results, retrieved chunks | yes | `openai` | `AiMinimizer`: names, phones, e-mails and booking refs become tokens resolved server-side; IDs, cards, DOB removed; tool-result allow-list (`src/modules/ai/minimization/`). Default on (`AI_MINIMIZER_ENABLED=true`). Per-tenant residency switch fails closed and is off by default (`AI_DATA_RESIDENCY_ENABLED`) | built; vendor terms `VC` |
| F9 | Backend → OpenAI vision | guest-uploaded images | yes | `openai` | Off by default (`AI_VISION_ENABLED=false`); the file is stored and offered to the clinic instead | built, off |
| F10 | Backend → OpenAI embeddings / batch | knowledge documents, memory text | yes | `openai` | `scrubForEmbedding` applied before embeddings; batches: the only producer is knowledge ingestion (clinic content, embedded as written); the upload seam scrubs any chat-completions batch and refuses unreviewed endpoints (`minimization/batch-minimizer.ts`) | partly built, `CV` |
| F11 | Backend → Meta WhatsApp | phone, template variables, session text, media | yes | `meta-whatsapp` | Content policy at both send seams (`src/modules/whatsapp/whatsapp-content-policy.ts`): variable allow-list, prohibited-pattern check, opt-in for marketing | built; consent evidence incomplete (`CV`) |
| F12 | Meta → backend webhook | inbound messages, media | inbound | `meta-whatsapp` | HMAC verified; classified D4 on arrival and kept in the boundary | built |
| F13 | Backend → Tap | payer name/contact, amount; card entered on Tap's page | `VC` | `tap` | Only Tap ids, brand, scheme, last four are stored; no card number or CVV | built |
| F14 | Backend → e-mail provider | recipient, subject, body variables | yes | `resend` / `aws` (SES) | Minimal appointment notices; identifiers redacted from free text (`src/modules/email/email.templates.ts`) | built |
| F15 | Backend → logs | request metadata, errors, `failedReason` | depends on the Region | host | Redacting logger, log scrubber and exception-filter scrubbing (`src/common/logging/`, `src/common/utils/log-scrubber.util.ts`); no bodies, tokens, prompts or message text | built; `notification_logs.error_message`, the notification `failure_reason` and the queue failedReason are scrubbed at the write seam. DLQ `originalData` is the replay payload and is kept until its stamped expiry (WhatsApp DLQ 6 h; other DLQs hold ids only) |
| F16 | DB → backups | full database | depends on the Region; DR copy off | host | Backup copy only into `approved_dr_destinations` (Terraform validation) and approved vault ARNs (SCP) | built (IaC, not applied) |
| F17 | AWS → `us-east-1` | health-check metric, alarm text, SNS e-mail | yes (US) | `aws` | Alarm text built from static strings; SCP allows only the 21 alarm/SNS actions there (`modules/org-guardrails`) | built (not applied) |
| F18 | CI → AWS | images, plans, state reads | yes | `github` | OIDC, no patient data in CI; plan artifacts treated as D6 | built; `CV` |

## Not on the map yet

- Tenant-configured outbound integrations (clinic-chosen webhook and partner endpoints): the clinic is the controller of that transfer; destinations are SSRF-guarded (`tenant-configured` in the register).
- Marketplace patient accounts and the public booking flow: classified in `DATA-CLASSIFICATION.md`; the controller/processor split is L9.
- Support cases with AWS or any vendor: no patient data may go in them (rule, not a technical control).

## Keeping it true

A new outbound call, vendor SDK or hostname fails `subprocessor-egress.spec.ts` until it is in the register; a new table fails `data-classification.spec.ts` until it is classified. This file is written by hand: when a flow row changes, change the code and this table in the same pull request.
