# Data residency, region strategy, data flows and PDPL status

| | |
|---|---|
| **Last revised** | 2026-10-15 (consolidation); sources dated 2026-10-10 |
| **Documentation status** | Consolidated. Part A is current-state and verification; later parts are preserved dated documents. |
| **Scope** | Technical position on where data lives and moves, the region parameterisation, the per-flow map, the PDPL status register and the transfer-impact worksheet. Not a compliance claim. |
| **Code references** | `modules/platform/variables.tf` (`approved_regions`), `infra/scripts/region-gate.sh`, `src/modules/data-governance/` |

## Contents

- [Part A: Current state and verification](#part-a-current-state-and-verification)
  - [A.1 Where things stand](#a1-where-things-stand)
  - [A.2 Open items](#a2-open-items)
  - [A.3 Related files kept separate (code-checked tables)](#a3-related-files-kept-separate-code-checked-tables)
  - [A.4 Source documents merged into this file](#a4-source-documents-merged-into-this-file)
- [Part B: Data residency (technical position)](#part-b-data-residency-technical-position)
  - [Facts this rests on](#facts-this-rests-on)
  - [The boundary (target state)](#the-boundary-target-state)
  - [What enforces it (all written and tested; **none applied**)](#what-enforces-it-all-written-and-tested-none-applied)
  - [What it does not do](#what-it-does-not-do)
  - [Decisions that gate real data](#decisions-that-gate-real-data)
- [Part C: AWS Region strategy](#part-c-aws-region-strategy)
  - [Current state](#current-state)
  - [Rules](#rules)
  - [Per-Region facts to confirm (Launch Readiness Gate)](#per-region-facts-to-confirm-launch-readiness-gate)
  - [Sequence](#sequence)
- [Part D: Data flows](#part-d-data-flows)
  - [Not on the map yet](#not-on-the-map-yet)
  - [Keeping it true](#keeping-it-true)
- [Part E: PDPL status register](#part-e-pdpl-status-register)
  - [1. Instruments](#1-instruments)
  - [2. Obligation areas and what exists in the repository](#2-obligation-areas-and-what-exists-in-the-repository)
  - [3. Open legal questions (from the plan)](#3-open-legal-questions-from-the-plan)
  - [4. Rule for this file](#4-rule-for-this-file)
- [Part F: Transfer impact assessment (worksheet)](#part-f-transfer-impact-assessment-worksheet)
  - [Gate per flow (plan section 9)](#gate-per-flow-plan-section-9)
  - [Worksheet](#worksheet)
  - [Risk-assessment inputs (to hand to counsel)](#risk-assessment-inputs-to-hand-to-counsel)

---


## Part A: Current state and verification

> Authored in the 2026-10-15 consolidation. Parts B–E are preserved. Where Part A and a later part disagree,
> **Part A wins**. This file is tracked in git (it is on the backend `.gitignore` allow-list).

### A.1 Where things stand

- **Nothing here is a compliance claim.** Each source document says so: they are technical positions, registers
  and worksheets. Every *legal* column (legal basis, transfer mechanism, retention period, breach-notification
  deadline) is **open** and needs counsel (`LC`) or official verification (`OV`).
- **Hosting location:** no AWS Region is inside Saudi Arabia (as of the plan's audit; re-check the Regions page).
  The stack runs in **`eu-central-1`** by the owner's chat decision D-1 of 2026-10-08, listed in
  `approved_regions` in `environments/production/terraform.tfvars`. Whether health data may be hosted there
  (L1/L2) is **unanswered**.
- **Technical controls built (default-off where noted):** region allow-list + region gate, data-classification
  and subprocessor registers generated from code, retention mechanism with no values, org-guardrail SCP module
  (not applied — the account is not in an Organization), log redaction ([`LOGGING.md`](../../LOGGING.md)).
- **No DPA / SCC / transfer-risk document or subprocessor list for any provider is held in this repository.**

### A.2 Open items

| Item | Status |
|---|---|
| Legal answers L1/L2 (hosting outside KSA), L10, L11, L12 (retention), L13 | **Pending** (counsel) |
| Written vendor confirmation of region and retention per subprocessor (`VC`) | **Pending** |
| Apply org guardrails (needs an AWS Organization) | **Pending** — [runbook](../runbooks/org-guardrails-rollout.md) |
| Re-check the Saudi AWS Region availability | **Not Verified** |

### A.2b Region consolidation, 2026-10-15 (verified against the live account, 270370109141)

**Result:** every regional workload resource is in `eu-central-1`. Verified by describing 18 enabled regions
(CloudWatch, SNS, VPC/EC2, NAT, EIP, RDS, ElastiCache, ECS, KMS, Secrets Manager, Logs, Lambda, GuardDuty,
Config, Backup, ECR, ACM, WAFv2, SQS, EventBridge, DynamoDB, CloudFormation, SES, SSM) and all 5 S3 buckets
(`get-bucket-location` = `eu-central-1`). No CloudFront distribution, no hosted zone (DNS is on Vercel).

| Outside `eu-central-1` | Why it stays | Owner in code |
|---|---|---|
| Route 53 health check `api.ziyaratech.com` (id `90de36ee-…`, global service) | **Retained, unalarmed — pending your decision.** Its only consumer was the removed us-east-1 alarm (no hosted zone, no failover record). It costs ~$1.5/mo and alerts nobody. Delete with `enable_external_health_check = false` + apply, once you accept the monitoring gap below. | `modules/monitoring/main.tf` `aws_route53_health_check.api` |
| CloudTrail `zt-production-trail` (home `eu-central-1`, multi-Region) | Deliberate: records API calls in every Region, so use of an unapproved Region is visible | `modules/account-baseline` |
| Default VPC in each of 17 other Regions | **Deleted 2026-10-15** (each verified empty first; re-creatable with `aws ec2 create-default-vpc`). None remain; verified `describe-vpcs` = 0 in all 17. | none (AWS-created) |
| `me-south-1` | **Not verifiable**: every endpoint timed out from the operator machine, so no inventory exists for it. | none |

**Guards added:** `infra/scripts/region-gate.sh` now fails if any environment's `aws_region` differs from
`PLATFORM_REGION` (default `eu-central-1`) and if any `.github/workflows/*.yml` names a region other than the
single `PLATFORM_REGION` guard; `deploy-aws.yml` refuses a `vars.AWS_REGION` other than `eu-central-1`.
Staging's `aws_region` was `me-central-1` (not deployed, still not approved); it is now `eu-central-1`.

**Alerts exclusively in `eu-central-1` (2026-10-15):** the us-east-1 alarm `zt-production-critical-api-unreachable-from-internet`,
the SNS topic `zt-production-alerts-external` and its two subscriptions (both `PendingConfirmation`) were destroyed via
Terraform (plan: 0 add, 0 change, 4 destroy) and verified: `describe-alarms` = 0 and `list-topics` = 0 in `us-east-1`;
the Terraform state holds no `us_east_1` / `external_health` address.
`aws sns list-subscriptions --region us-east-1` still lists the two orphaned `PendingConfirmation` entries (their topic
no longer exists). AWS expires unconfirmed subscriptions on its own (about 3 days); they cannot be unsubscribed by ARN
and cannot be confirmed (no topic), so they deliver nothing. Re-check on or after 2026-10-19 that the list is empty. The `us_east_1` provider alias, its module wiring,
the org-guardrails `us_east_1_health_check_exception` variable/statement and the matching SCP tests were removed.
`organizations_api_region = "us-east-1"` in `environments/org-guardrails` is the AWS Organizations *API endpoint* (not an
alert resource) and is retained; the root is not applied (no AWS Organization).

**Monitoring no longer provided:** the external, global-checker probe of `https://api.ziyaratech.com/api/v1/health`.
It was the only signal that could see a full eu-central-1 outage or an internet-path/DNS failure (in-Region alarms cannot
report their own Region's loss). Still covered in-Region: ALB healthy/unhealthy targets, 5xx rate, p95 latency, ECS
running tasks, RDS/Redis/NAT/SES/payment alarms. **Not covered:** regional outage, Vercel-DNS or certificate-path failure
seen from the internet. A same-Region CloudWatch Synthetics canary would not detect a regional outage either; an
independent non-AWS uptime monitor on the API health URL is the only equivalent (not set up — your decision).

### A.3 Related files kept separate (code-checked tables)

`DATA-CLASSIFICATION.md`, `RETENTION-POLICY.md`, `SUBPROCESSORS.md` contain tables **generated from code**
and verified by `compliance-docs.spec.ts`; they are not merged here (see [README](../README.md)).

### A.4 Source documents merged into this file


| Former file (`infra/docs/`) | Now |
|---|---|
| `DATA-RESIDENCY.md` | [Part B](#part-b-data-residency-technical-position) |
| `AWS-REGION-STRATEGY.md` | [Part C](#part-c-aws-region-strategy) |
| `DATA-FLOW.md` | [Part D](#part-d-data-flows) |
| `PDPL-COMPLIANCE.md` | [Part E](#part-e-pdpl-status-register) |
| `TRANSFER-IMPACT-ASSESSMENT.md` | [Part F](#part-f-transfer-impact-assessment-worksheet) |


---

## Part B: Data residency (technical position)

Former top-level content of `DATA-RESIDENCY.md` (path unchanged).

Residency plan sections 1, 7, 12, 15. **Technical position only.** It does not say that hosting anywhere is lawful and it is not a statement of PDPL compliance. Whether Ziyarati may host health data outside the Kingdom, and under which mechanism, is L1/L2 and is unanswered.

### Facts this rests on

| Fact | Status |
|---|---|
| AWS has no Region inside Saudi Arabia today (an announced Saudi Region is not generally available) | `C` as of the plan's audit; re-check with the AWS Regions page before relying on it (`OV`) |
| Bahrain, UAE and Frankfurt are transfers outside the Kingdom; CloudFront edge presence in KSA is not residency | `C` |
| PDPL conditions transfers; whether health-sector rules require in-Kingdom hosting of a clinic-management SaaS | `LC` (L1) |
| Production runs today on Railway, Cloudflare R2, Resend and Vercel | `CV` against live settings |
| Nothing in `infra/terraform` has ever been applied | `C` |

### The boundary (target state)

**Inside:** D2-D7, plus D8 until its payload is verified clean: database and backups, object storage and versions, Redis, embeddings (pgvector), runtime that handles clinical data, logs, audit tables, secrets, encryption keys.
**Outside is acceptable:** D0, D1, and verified-clean D8.
**Crossing needs a registered processor, a mechanism and minimisation:** F1-F3, F8-F11, F13, F14, F18 (`Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)`).
Classes are defined in `DATA-CLASSIFICATION.md`; processors in `SUBPROCESSORS.md`.

### What enforces it (all written and tested; **none applied**)

| Layer | Control | Where | Proven by |
|---|---|---|---|
| Plan time | `aws_region` must be a member of `approved_regions` (no default; empty until approved) | `modules/platform/variables.tf` | `platform.tftest.hcl` |
| Plan time | `dr_backup_region` must be empty or in `approved_dr_destinations` | same | same |
| Plan time | No region literal and no replication / replica / multi-Region key / CloudFront / Bedrock / log-shipping construct in Terraform | `infra/scripts/region-gate.sh static` | CI `static` job |
| Plan time | Environment regions must sit inside the organisation SCP region list | `region-gate.sh` (`check_org_guardrails`) | CI `static` job |
| Apply time | A Region must be approved before any plan or apply | `region-gate.sh deploy` | `plan` / `preview` / `apply` jobs |
| Resource | Single-Region KMS keys; S3 replication denied; RDS no replica / backup replication; Valkey no global datastore; no secret replicas | module tests | `terraform test` per module |
| Organisation | SCPs: deny unapproved Regions (global control plane exempt; no per-region exception, `us-east-1` is denied like every other unapproved region), deny copy/replication features, deny disabling audit | `modules/org-guardrails`, `environments/org-guardrails` | `policies.tftest.hcl`, `scp-semantics.test.cjs` |
| Application | Minimiser, vision gate, WhatsApp / e-mail content policy, log and job-payload scrubbing | `src/` (see `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)`) | `npx jest` |
| Release | `compliance/production-gate.yaml` must be fully evidenced before a production deploy or apply | `infra/scripts/production-gate.cjs enforce` | `production-gate.test.cjs` |

### What it does not do

- An SCP never restricts the management account or service-linked roles, cannot see the Region of a service-initiated copy, and cannot constrain SNS subscriptions, EventBridge targets or in-account sharing (`runbooks/org-guardrails-rollout.md` section 2).
- None of the infrastructure controls protects data that is **not** on AWS. Today that is everything: the live data is on Railway / R2 / Resend / Vercel and is governed by the application-layer controls only.
- Global control-plane services (IAM, billing, support, Route 53) keep working from anywhere. **No patient data in resource names, tags, descriptions or support cases.**
- There is no `us-east-1` exception any more (removed 2026-10-15): the SCP denies it like any other unapproved region.

### Decisions that gate real data

| # | Decision | State |
|---|---|---|
| L1 | Is in-Kingdom hosting mandatory for this product? | open (`LC`) |
| L2 | Is an interim foreign Region acceptable, and under which mechanism? | open (`LC`) |
| L13 | Disaster-recovery scenario | open (`LC` + owner) |
| L14 | May the authenticated app shell be served from Vercel? | open (`LC`) |

The only recorded location statement is the owner's 2026-10-08 chat decision (D-1), which put `eu-central-1` in `approved_regions` in `environments/production/terraform.tfvars` so the region gate passes. That is a **technical allow-list entry, not a legal approval**: the production-gate item `legal-hosting-approval` stays open until written advice exists, and the organisation-guardrails root deliberately does not assume it (its `approved_regions` is empty). See `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part C)`.

---

## Part C: AWS Region strategy

> **Former file:** `AWS-REGION-STRATEGY.md`

Residency plan sections 1, 8, 22. **No AWS Region is inside Saudi Arabia today** (`C` at the plan's audit date; check the official Regions page before relying on that, `OV`). This document says how the stack is parameterised so a Region can be added or moved safely; it does not choose a Region. Choosing one is a legal decision (L1/L2, `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part E)`).

### Current state

| Item | State |
|---|---|
| Stack Region | `eu-central-1`, from the owner's 2026-10-08 chat decision (D-1); in `approved_regions` in `environments/production/terraform.tfvars` |
| Legal approval of that location | **none recorded**; production-gate item `legal-hosting-approval` is open |
| State | one state per Region: key `platform/<region>/terraform.tfstate`, Region supplied by `backend.hcl` |
| Organisation SCP list | empty on purpose (`environments/org-guardrails`); not applied |
| Saudi Region | not available; announced date and service list unverified (`OV`) |
| Anything applied | nothing |

### Rules

1. **A Region is never changed in place.** Flipping `aws_region` on an existing state makes Terraform destroy and recreate everything. Each Region gets its own state key and its own stack from the same modules; data moves by backup / restore; DNS switches last.
2. **One allow-list.** `approved_regions` is empty by default. `aws_region` must be a member; `dr_backup_region` must be empty or in `approved_dr_destinations`. The organisation SCP list must be a superset of every environment's regions (`region-gate.sh` checks both directions).
3. **No region literal and no provider alias for another region in Terraform** (`region-gate.sh static`).
4. **Per-Region recreation:** KMS keys, secrets, certificates, ECR images and SES identities are recreated in each Region; none is replicated.
5. **Adding a Region** is one reviewed change that touches the environment tfvars **and** the organisation SCP list together; the gate fails if only one moves.

### Per-Region facts to confirm (Launch Readiness Gate)

The gate fails if any line is not evidenced from AWS's official service list or a live check **in that Region**. Nothing below is assumed.

| Check | Must be true |
|---|---|
| Region generally available and enabled for the account | yes |
| RDS PostgreSQL (required major version, Multi-AZ, PITR, Performance Insights if kept, CA bundle) | available |
| ECS + Fargate (platform version, architecture in use) | available |
| ElastiCache Valkey (version, TLS, Multi-AZ) | available |
| S3 (versioning, lifecycle, gateway endpoint), KMS, Secrets Manager | available |
| CloudWatch Logs / metrics / alarms; CloudTrail incl. S3 data events | available |
| ALB, regional WAF with the managed rule groups in use, ACM | available |
| ECR, SQS, SNS, EventBridge, GuardDuty, IAM Access Analyzer | available |
| SES | available, or the alternative e-mail path is approved |
| AWS Backup for RDS | available |
| VPC interface endpoints for each service in `interface_endpoint_services` (the SES endpoint service name `email` is unverified) | available |
| Three Availability Zones usable by the account | yes |
| Service-managed storage (RDS backups / snapshots, Performance Insights, CloudTrail history, ElastiCache snapshots) documented as in-Region | yes |
| Backup and DR destination decided (`DISASTER-RECOVERY.md` section 5) | yes |
| Support / operations access terms for the Region reviewed | yes |
| Staging stack applied, tested and restore-drilled in the Region | yes |
| Counsel confirms the move and the decommissioning of the interim location | yes |

### Sequence

0. Legal-independent engineering (done in this repository).
1. Staging in an approved Region, synthetic data only. Legal approval is still needed if that Region will later hold real data.
2. Production cut-over from Railway: after the production gate (`compliance/README.md`); sequence in `Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part B)`, plus deletion evidence from Railway, R2 and Resend afterwards.
3. Move to a Saudi Region when one is live: Launch Readiness Gate above, new stack and state key, data migration, DNS, decommission the interim Region.

---

## Part D: Data flows

> **Former file:** `DATA-FLOW.md`

Residency plan section 6. One row per flow that moves personal data between systems, with what the **code** does about it today. It is a map, not an assessment: the legal columns (basis, mechanism) are in `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part E)` and `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part F)`, and every mechanism is **missing** until a document exists.

Status words: **built** (implemented and tested in this repository), **built, off** (implemented, default-off or needs a deployment setting), **open** (not built or not decided), `CV` (needs code verification), `VC` (needs vendor confirmation), `LC` (needs counsel), `OV` (needs official verification).

PD personal · SD sensitive identifiers · HD health · AU authentication · PY payment.

| # | Flow | Data | Leaves KSA | Processor (register id) | What the code does today | Status |
|---|---|---|---|---|---|---|
| F1 | Browser → Vercel (pages) | page requests, cookies (PD, AU) | yes | `vercel` | Static/public shell. Whether the authenticated shell may be served from Vercel is L14 | open, `LC` |
| F2 | Browser → Vercel → backend `/api/*` | **every REST body** (PD, SD, HD, AU, PY) | yes | `vercel` | Direct API routing: with `NEXT_PUBLIC_API_BASE_URL` set the browser calls the API host and no `/api` rewrite is registered (`Ziyarati-font/next.config.ts`, `app/lib/api/api-base.ts`). **Default is still the proxy until that variable is set in the deployment** | built, off |
| F3 | Browser → Vercel Analytics | URL paths, device data | yes | `vercel` | Mounted on public routes only (`app/components/analytics/PublicAnalytics.tsx`) | built; `CV` that public URLs carry no identifiers |
| F4 | Browser → backend WebSocket (AI chat) | chat turns (PD, HD) | depends on the API host's Region | host | Origin / Fetch-Metadata admission and guest room isolation (CSWSH remediation) | built; hosting open |
| F5 | Backend → PostgreSQL | system of record, embeddings | depends on the Region | `railway` now / `aws` planned | TLS (`verify-full`), env CMK, PITR 14 d planned | hosting decision open (L1/L2) |
| F6 | Backend → Redis / BullMQ | job payloads: recipient + variables (e-mail, WhatsApp), AI text | depends on the Region | same | PII redaction for jobs (`src/queue/job-pii-redaction.ts`); failed PII jobs kept 6 h; completed 1 h (`queue.constants.ts`). Queued payloads already in Redis are not rewritten | built; residual gap listed in `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part E)` |
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
| F17 | AWS → `us-east-1` | ~~health-check metric, alarm text, SNS e-mail~~ | **removed 2026-10-15**: no alarm, topic or subscription exists in `us-east-1` | `aws` | — | closed |
| F18 | CI → AWS | images, plans, state reads | yes | `github` | OIDC, no patient data in CI; plan artifacts treated as D6 | built; `CV` |

### Not on the map yet

- Tenant-configured outbound integrations (clinic-chosen webhook and partner endpoints): the clinic is the controller of that transfer; destinations are SSRF-guarded (`tenant-configured` in the register).
- Marketplace patient accounts and the public booking flow: classified in `DATA-CLASSIFICATION.md`; the controller/processor split is L9.
- Support cases with AWS or any vendor: no patient data may go in them (rule, not a technical control).

### Keeping it true

A new outbound call, vendor SDK or hostname fails `subprocessor-egress.spec.ts` until it is in the register; a new table fails `data-classification.spec.ts` until it is classified. This file is written by hand: when a flow row changes, change the code and this table in the same pull request.

---

## Part E: PDPL status register

> **Former file:** `PDPL-COMPLIANCE.md`

Residency plan sections 3, 4, 23, 24. **This is a status register, not a compliance claim.** The repository cannot establish compliance with the Personal Data Protection Law or any sector rule; that needs counsel and the regulators' texts. Several instruments below could not be read from the build environment (`OV`). Article numbers and deadlines are deliberately **not** quoted anywhere in this repository because none has been verified against the official text.

Status vocabulary: `C` confirmed from the repo or an official source read directly · `OV` needs official verification · `LC` needs Saudi legal counsel · `VC` needs vendor confirmation · `CV` needs code verification.

### 1. Instruments

| Id | Instrument | Applies to Ziyarati | Status |
|---|---|---|---|
| R1 | Personal Data Protection Law (SDAIA) | yes, as a processor of personal data of people in KSA | applicability `C`; detail `OV` |
| R2 | PDPL Implementing Regulation (health-data controls, processor duties, records, breach notice, DPIA, DPO) | yes | `OV` |
| R3 | Regulation on Personal Data Transfer outside the Kingdom | yes, today (Vercel, OpenAI, Meta, Resend, R2, Railway) | `OV` |
| R4 | Standard Contractual Clauses for transfer | where relied on | `OV` |
| R5 | Risk Assessment Guideline for transfers | where relied on | `OV` |
| R6 | NHIC Telehealth Application Guidelines (in-Kingdom storage sentence) | text `C`; binding force and scope for a non-telehealth SaaS `LC` | `LC` |
| R7 | Saudi Health Information Exchange Policies IS0303 | exchange participants and their associates; triggered by NPHIES integration | `LC` |
| R8 | MoH / CHI rules for licensed facilities' records | not located | `OV` + `LC` |
| R9-R10 | NCA ECC-2:2024, CCC-2:2024 | direct or only through customer contracts | `LC` |
| R11 | CST Cloud Computing Services Provisioning Regulations | registration for a SaaS | `LC` |
| R12 | NDMO data governance | government customers only | `LC` |
| R13 | SAMA payment rules | indirect via Tap | `VC` |

### 2. Obligation areas and what exists in the repository

"Technical control" means a mechanism that supports the duty. It does not mean the duty is met; each row's last column says what is still outstanding.

| Area | Technical control in the repository | Where | Still outstanding |
|---|---|---|---|
| Records of processing | Table classification, flow map, subprocessor register | `DATA-CLASSIFICATION.md`, `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)`, `SUBPROCESSORS.md` | Counsel's format; DPIA export (P16) not built |
| Lawful basis, consent | Customer consent state; WhatsApp marketing needs recorded opt-in | `Customer` consent migration, `whatsapp-content-policy.ts` | Wording and basis (L11); consent evidence per channel is incomplete (`CV`) |
| Data minimisation | AI minimiser, vision gate, WhatsApp / e-mail content policy, job-payload redaction, log scrubbing | `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)` F6-F15 | Batch-job guard covers the chat endpoint only (embeddings batches are clinic knowledge content, embedded as written like the sync path); queued payloads already in Redis; DLQ `originalData` is kept un-minimised on purpose (replay needs it) and expires on a stamped deadline (WhatsApp DLQ 6 h, the other three DLQs carry ids only) |
| Transfers | Register, egress allow-list test, per-flow gating by feature flag | `SUBPROCESSORS.md` | **No DPA, SCC or risk assessment for any processor** (`Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part F)`) |
| Access control | Tenant isolation, RBAC, platform-admin audit | application | D4 read-audit (P14) status `CV` |
| Security | Encryption at rest and in transit, WAF, GuardDuty, CloudTrail, SCPs, private subnets | `AWS-SECURITY.md` | Nothing applied; penetration test not done |
| Data-subject rights | Request intake, export, erase, restrict, close; evidence record | `privacy/requests` (`data-subject-request.*`) | Statutory time limits and identity-verification rules (`OV`) |
| Retention and deletion | Retention engine with no built-in values; patient erase; tenant offboarding | `RETENTION-POLICY.md` | L12; backups, Redis and processor copies are not reached by deletion |
| Breach handling | Runbook scaffold | `INCIDENT-RESPONSE.md` | Notification deadline and recipients (`OV`/`LC`); contacts; an exercise |
| DPO / controller registration | none | - | L5 |
| Residency | Region allow-list, SCPs, copy denies, release gate | `DATA-RESIDENCY.md` | L1, L2; the Saudi Region is not available |

### 3. Open legal questions (from the plan)

| # | Question | Blocks |
|---|---|---|
| L1 | Is in-Kingdom hosting of health data mandatory for a clinic-management SaaS? Which instrument and article? | any hosting of real data |
| L2 | Is an interim foreign Region acceptable, and under which mechanism? | staging-with-future-production, production |
| L3 | If Frankfurt: GDPR position of Ziyarati and AWS | L2 |
| L4 | CST registration | production |
| L5 | SDAIA controller registration; DPO | production |
| L6 | NCA ECC/CCC: direct or via contracts | sales to hospitals / government |
| L7 | Government-entity customers: hosting or classification duties | selling to them |
| L8 | NPHIES / exchange integration and IS0303 | that integration |
| L9 | Controller vs processor split (clinic data, marketplace, public AI booking) | contracts, notices |
| L10 | Mechanism per processor; where a risk assessment is mandatory | `SUBPROCESSORS.md` |
| L11 | Lawful basis and consent wording for AI processing and WhatsApp | minimiser, WhatsApp |
| L12 | Clinical record retention periods | `RETENTION-POLICY.md` |
| L13 | Disaster-recovery scenario | production |
| L14 | May the authenticated app shell be served from Vercel? | `DATA-RESIDENCY.md` |

### 4. Rule for this file

A row changes status only when the evidence named in it exists (a document, a test, a record) and the change is reviewed. Do not write "compliant", "certified" or an article number here without the official text and counsel's confirmation.

---

## Part F: Transfer impact assessment (worksheet)

> **Former file:** `TRANSFER-IMPACT-ASSESSMENT.md`

Residency plan sections 9, 18. **A worksheet with the factual columns filled from the repository and every legal column left open.** No conclusion is drawn here: whether a transfer is permitted, which safeguard applies and whether a risk assessment is mandatory are `LC` (L2, L10). The SDAIA transfer regulation, SCCs and risk-assessment guideline could not be read from the build environment (`OV`); take the criteria from the official texts, not from this file.

### Gate per flow (plan section 9)

A flow that leaves the Kingdom may run in production only when **all five** are evidenced; otherwise it is disabled by feature flag, not left running.

1. Legal basis (L11)
2. DPA evidence (`SUBPROCESSORS.md`)
3. SCC evidence, or counsel's written alternative (L10)
4. Transfer risk assessment, where counsel says it is required
5. The minimisation control named in `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)`

### Worksheet

Facts are from `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)` and `SUBPROCESSORS.md`. A blank cell is open. Status of gates 1-4 is **missing** for every row today: no DPA, SCC, assessment or legal basis document is held in this repository.

| Flow | Processor | Data classes | Health data | Volume / frequency | Minimisation (gate 5) | Off switch if gates are missing | 1 basis | 2 DPA | 3 SCC | 4 risk assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| F1-F2 pages and REST | Vercel | D2, D4, D6 | yes | | direct API routing (built, off until `NEXT_PUBLIC_API_BASE_URL` is set) | set the variable; REST leaves Vercel | | | | |
| F3 analytics | Vercel | D1 | no (public pages only) | | public routes only | remove `PublicAnalytics` | | | | |
| F8 AI chat | OpenAI | D2, D4 | yes | | `AiMinimizer` | `AI_MINIMIZER_ENABLED` is a safety switch, **not** an off switch; disable the AI feature per tenant/plan | | | | |
| F9 AI vision | OpenAI | D2, D3, D4 | yes | | off by default | `AI_VISION_ENABLED=false` | | | | |
| F10 embeddings / batch | OpenAI | D2, D4 | possible | | `scrubForEmbedding`; batch upload seam scrubs chat batches, embeddings batches carry clinic knowledge as written | disable knowledge ingestion / batch jobs | | | | |
| F11 WhatsApp | Meta | D2 | possible | | content policy at both send seams | disable the WhatsApp channel per tenant | | | | |
| F13 payments | Tap | D2, D5 | no | | hosted page; no card data stored | disable online payment | | | | |
| F14 e-mail | Resend / SES | D2 | possible | | minimal notices, free-text redaction | `EMAIL_PROVIDER=noop` | | | | |
| F7 storage | Cloudflare R2 | D2, D4 | yes | | none beyond encryption (migration to the approved Region planned) | - | | | | |
| F5-F6, F15-F16 hosting | Railway (now) / AWS (planned) | D2-D8 | yes | | see `DATA-RESIDENCY.md` | - | | | | |

### Risk-assessment inputs (to hand to counsel)

For each flow counsel decides to assess, the technical inputs available are: the data classes above, the field-level allow-lists and redaction code named in `Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part D)`, the vendor's region / retention / sub-processor answers once obtained (`VC`), encryption in transit (TLS) and at rest where applicable, and the DPIA inventory (`DATA-CLASSIFICATION.md`; the export tool is not built).

Sign-off for each row: assessor, date, outcome, review date. Record it in the contract repository and reference it from `compliance/production-gate.yaml` (`scc-or-alternative`); do not commit privileged opinions to this repository.
