# Retention policy

Residency plan P12 / L12. **There is no approved retention schedule.** How long a clinic must or may keep a clinical record, an invoice or an audit trail is a legal input (L12) that is not recorded anywhere in this repository. This document records the mechanism, what has no value yet, and what is already aged out. Nothing here is a retention commitment.

## Principle

An unset target means **keep**. That is the only safe default while the right period is undecided. No built-in value exists for any target below.

## Targets with a mechanism and no value

Run by `src/modules/data-governance/retention.service.ts`; a target is inert until its setting is given. Defined in `retention-policy.ts`; `retention.spec.ts` enforces the never-purged list.

<!-- BEGIN GENERATED: retention-targets -->
| Target | Table | Action | Classes | Setting (unset = keep) | Measured on | Why it is safe to age out |
| --- | --- | --- | --- | --- | --- | --- |
| `EMAIL_LOGS` | `email_logs` | delete | D2, D8 | `RETENTION_EMAIL_LOGS_DAYS` | `created_at` | Delivery log: recipient address, subject and the template variables. Idempotency only matters within a send window. |
| `WHATSAPP_WEBHOOKS` | `whatsapp_webhooks` | delete | D2, D8 | `RETENTION_WHATSAPP_WEBHOOKS_DAYS` | `created_at` | Raw inbound provider payload, kept only for replay and debugging. Unprocessed events are never touched. |
| `SCHEDULED_NOTIFICATION_VARIABLES` | `scheduled_notifications` | scrub | D2 | `RETENTION_SCHEDULED_NOTIFICATION_VARIABLES_DAYS` | `created_at` | A finished reminder no longer needs the recipient details it was rendered from. The row (status, timing) stays. |
| `AI_TRANSCRIPTS` | `ai_messages` | delete | D2, D4 | `RETENTION_AI_TRANSCRIPTS_DAYS` | `created_at` | AI chat transcript. The conversation row and the patient-facing message history are not affected. |

Never aged out by a schedule:

| Scope | Reason |
| --- | --- |
| D3 / D4 patient identity and clinical records (customers, customer_profiles, clinical_*, appointments, customer_notes, customer_files) | Retention duty is an unsettled legal question (L12); removed only by an explicit subject deletion. |
| D5 payment and accounting records (invoices, payments, refunds, transactions, settlements) | Accounting retention is a legal duty of the clinic. |
| D7 audit trails (audit_logs, clinical_access_logs, data_subject_requests, deletion_evidence) | Accountability evidence must outlive the data it describes. |
<!-- END GENERATED: retention-targets -->

## Aged out today (existing settings, defaults in code)

| Data | Setting | Default |
|---|---|---|
| Analytics events | `ANALYTICS_EVENT_RETENTION_DAYS` | 90 |
| AI tool-call records | `AI_TOOL_CALL_RETENTION_DAYS` | 90 |
| Auth tokens | `AUTH_TOKEN_RETENTION_DAYS` | 7 |
| Notification logs | `NOTIF_LOG_RETENTION_DAYS` | unset (keep) |
| Platform API / webhook logs | `PLATFORM_API_LOG_RETENTION_DAYS`, `PLATFORM_WEBHOOK_LOG_RETENTION_DAYS` | unset (keep) |
| Queue jobs | completed 1 h; failed 6 h on PII queues, 7 d elsewhere | in `queue.constants.ts` |

## Infrastructure (planned stack, nothing applied)

CloudWatch Logs 30 days (production) / 14 (staging) · ALB and WAF logs 30 days · CloudTrail 365 days · S3 non-current versions 30 days · RDS point-in-time recovery 14 days · **no expiry on current uploaded objects** until L12 is answered. See `SECURITY.md` section 6 and `DISASTER-RECOVERY.md` section 2.

## Deletion paths (not schedules)

| Path | What it removes | Evidence |
|---|---|---|
| Patient erase / anonymise (`POST /privacy/requests/:id/erase`) | per `subject-erasure.registry.ts` | `deletion_evidence` record |
| Tenant offboarding (operator CLI `src/tenant-offboard.ts`; tenant must already be inactive; dry-run available) | every tenant-owned table, computed from the schema, in one transaction; then every stored object version under `<tenantId>/` | `deletion_evidence` record, including the gaps below |
| Not reached by offboarding, reported in each evidence record | database backups and PITR (age out with the backup window), queue payloads and Redis keys (expire; failed PII jobs 6 h), logs (age out), copies held by processors (a separate manual request to each) | listed in `GAPS` in `tenant-offboarding.service.ts` |
| Backups of removed data | age out with PITR (14 days planned); not selectively erasable | state it in the notice to the requester |

## Open

| # | Decision | Owner |
|---|---|---|
| L12 | Clinical record retention periods (D4, D3) | counsel |
| - | Accounting / invoice retention (D5) | counsel / clinic |
| - | Audit-trail retention (D7) and how long deletion evidence is kept | counsel |
| - | Values for each `RETENTION_*_DAYS` above | owner, after L12 |
