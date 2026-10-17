# Data residency, region strategy, data flows and PDPL status

| | |
|---|---|
| **Last revised** | 2026-10-15 (rewritten against the live AWS account and the code; supersedes the 2026-10-10 sources) |
| **Documentation status** | Part A is the current state with its evidence. Parts B–F are the standing position, the Region rules, the flow map, the PDPL register and the transfer worksheet, corrected to Part A. |
| **Scope** | Where data and services actually are, how a Region is controlled, the per-flow map, the PDPL status register and the transfer-impact worksheet. **Not a compliance claim.** |
| **Code references** | `modules/platform/variables.tf` (`approved_regions`), `infra/scripts/region-gate.sh`, `src/modules/data-governance/` |

Evidence vocabulary used throughout: **Verified** = read from the live AWS account or the repository on
2026-10-15 (the command or file is named). **Owner statement** = said by the owner, not independently checked.
**Not verified** = no evidence in hand; do not rely on it. Legal statuses: `LC` needs counsel, `OV` needs
official verification, `VC` needs vendor confirmation, `CV` needs code verification.

## Contents

- [Part A: Current state and verification](#part-a-current-state-and-verification)
- [Part B: Data residency (technical position)](#part-b-data-residency-technical-position)
- [Part C: AWS Region strategy](#part-c-aws-region-strategy)
- [Part D: Data flows](#part-d-data-flows)
- [Part E: PDPL status register](#part-e-pdpl-status-register)
- [Part F: Transfer impact assessment (worksheet)](#part-f-transfer-impact-assessment-worksheet)

---

## Part A: Current state and verification

### A.1 Where things stand

- **Hosting:** the platform runs on AWS account `270370109141`, Region **`eu-central-1`** (Frankfurt), chosen by the
  owner's chat decision D-1 of 2026-10-08. **Frankfurt is outside the Kingdom.** No AWS Region is inside Saudi
  Arabia as far as this repository knows (`OV`: re-check the official Regions page; not re-checked on 2026-10-15).
  Whether health data may be hosted in Frankfurt (L1/L2) is **unanswered**. D-1 is a technical allow-list entry,
  not a legal approval: the production-gate item `legal-hosting-approval` is `open`.
- **Railway, Cloudflare R2 and Resend are no longer part of the running AWS deployment** (evidence in A.2). That is
  **not** the same as "removed": there is no deletion evidence for the external accounts or any data they held
  (A.4). Do not describe them as deleted until that evidence exists.
- **Nothing in this file is a compliance claim.** Every legal column (legal basis, transfer mechanism, retention
  period, breach-notification deadline) is open. **No DPA, SCC, transfer-risk assessment or subprocessor list for
  any provider is held in this repository.**

### A.2 Verified facts (live account, 2026-10-15)

| Area | Fact | How verified |
|---|---|---|
| Database | RDS `zt-production-pg`, PostgreSQL 17.9, Multi-AZ, storage encrypted with a KMS key, not publicly accessible, 14-day automated backups, 8 automated snapshots, Performance Insights on. Instance class is `db.t3.medium` | `rds describe-db-instances`, `describe-db-snapshots` |
| Database host in use | The `zt/production/database-url` secret points at `zt-production-pg.…eu-central-1.rds.amazonaws.com` | Secrets Manager (host only read) |
| Cache / queue | ElastiCache Valkey `zt-production-valkey` (replication group), Multi-AZ, at-rest and in-transit encryption on, `cache.t4g.small`; the `redis-url` secret points at `….euc1.cache.amazonaws.com` | `elasticache describe-replication-groups`, Secrets Manager |
| Compute | ECS cluster `zt-production`, API task definition `zt-production-api:16`; `STORAGE_PROVIDER=s3`, `EMAIL_PROVIDER=ses`, `PAYMENT_PROVIDER=tap`, `TAP_ENV=live`, `S3_BUCKET=zt-production-uploads-270370109141` | `ecs describe-task-definition` |
| Object storage | Bucket `zt-production-uploads-270370109141` in `eu-central-1`: SSE-KMS, versioning enabled, **4 objects (≈ 6.2 MB)** | `s3api get-bucket-location / encryption / versioning`, `s3 ls` |
| Other buckets | `alb-logs`, `cloudtrail`, `flowlogs`, `tfstate` buckets, all `eu-central-1` | `s3api get-bucket-location` |
| No Railway / R2 / Resend wiring | The running API task definition has **no** environment variable or secret name containing `R2_`, `railway`, `resend` or `cloudflare`; the app secret `zt/production/app` holds only JWT, credentials-encryption, META, METRICS, OPENAI and unsubscribe keys | task definition, `get-secret-value` (key names only) |
| DNS | `api.ziyaratech.com` resolves to `zt-production-api-….eu-central-1.elb.amazonaws.com` | `nslookup` |
| E-mail | SES in `eu-central-1`: identity `ziyaratech.com` verified for sending, DKIM `SUCCESS`, production access enabled, 50,000 / 24 h quota | `sesv2 get-account`, `get-email-identity` |
| Logs | Application log groups `/ziyaratech/production/{api,worker,migrate,ops}`: 30-day retention, KMS CMK | `logs describe-log-groups` |
| Audit / detection | CloudTrail `zt-production-trail` (home `eu-central-1`, multi-Region, kept on purpose); GuardDuty detector in `eu-central-1` | `cloudtrail describe-trails`, `guardduty list-detectors` |
| Other Regions | **No alarms, SNS topics, workload resources or default VPCs** in the 17 other reachable enabled Regions; no CloudFront distribution; no Route 53 hosted zone (DNS is on Vercel) | per-Region sweeps 2026-10-15, default VPCs deleted 2026-10-15 |
| Alerts | All alarms and SNS topics for project alerts are in `eu-central-1`. The us-east-1 health-check alarm and topic were destroyed on 2026-10-15 (Terraform: 0 add, 0 change, 4 destroy; AWS re-checked: 0 alarms, 0 topics) | `cloudwatch describe-alarms`, `sns list-topics` |
| Organisation SCPs | The account is **not** a member of an AWS Organization, so no SCP can apply | `organizations describe-organization` |
| Terraform | Production state holds 275 entries and has been applied. A fresh plan still shows **51 add, 8 change, 3 destroy** (logging/observability, task-definition replacements, in-place RDS/ElastiCache/budget changes). None of those items concerns Regions | `terraform plan` (read-only) |
| Release gate | `compliance/production-gate.yaml`: `legal-hosting-approval` is `open`; seven legal/document items are open with a temporary deferral to review by 2026-11-10 (deploy workflow opts in to deferrals) | file read |

### A.3 Controls that exist (written, tested) versus controls that are live

| Control | Written / tested | Live |
|---|---|---|
| Region allow-list at plan time, region gate in CI (`region-gate.sh`: environment region = `PLATFORM_REGION`, no region literal, no provider alias for another Region, workflows guarded) | yes, `platform.tftest.hcl`; gate run locally 2026-10-15 | passes locally; a CI run was not observed; `eu-central-1` only |
| Single-Region KMS keys, no S3/RDS/Valkey/secret replication constructs | yes, module tests | consistent with A.2 (single-Region resources); replication not observed |
| Organisation SCP module | yes, tested | **not applied** (no Organization) |
| Application minimisation (AI minimiser, vision gate, WhatsApp/e-mail policy, job and log scrubbing) | yes, `npx jest` | code is deployed; effective flag values in the running task were **not** all read (AI flags use code defaults unless set) |
| Backup copy to another Region | gated by `approved_dr_destinations` (empty) | none: no AWS Backup plan found, no cross-Region copy |

### A.4 Not verified / still open (read this before relying on the document)

| Item | Status |
|---|---|
| Deletion of the Railway project, its Postgres/Redis and logs; of the Cloudflare R2 bucket and its objects; of the Resend account and data | **Not verified.** No deletion evidence exists. The runbook still lists "decommission Railway" as pending |
| What data Railway / R2 / Resend ever held | The owner stated on 2026-10-08 that Railway held no real production data (**owner statement**, not checked). The contents of the R2 bucket and of Resend's logs are **unknown** |
| Whether R2/Railway credentials remain valid anywhere | Not verified (rotate or revoke when decommissioning) |
| Vercel `NEXT_PUBLIC_API_BASE_URL` (direct API routing, flow F2) | **Not verified.** It is not in the repository's env files; the default is the `/api` proxy through Vercel |
| Live values of `AI_MINIMIZER_ENABLED`, `AI_VISION_ENABLED`, `AI_DATA_RESIDENCY_ENABLED` | Not read from the running task; code defaults apply unless set |
| Saudi AWS Region availability | Not re-checked (`OV`) |
| Legal answers L1/L2, L10–L14 | Open (`LC`) |
| Written vendor confirmation of Region and retention per processor (`VC`) | Open |
| SES delivery to a real inbox | Not verified in this review |
| `me-south-1` | Not inventoried: every endpoint timed out from the operator machine |

### A.5 Code and register drift (documentation cannot fix these)

- `src/modules/data-governance/subprocessor-register.ts` (source of the generated `SUBPROCESSORS.md` table) still
  lists **Railway, Cloudflare R2 and Resend as `active`** and **AWS as `planned`**. That contradicts A.2.
  `SUBPROCESSORS.md` therefore also still says so until the register is changed.
- The code still contains the R2 and Resend paths, and **`STORAGE_PROVIDER` defaults to `r2`** in
  `src/config/env.validation.ts`. Production is safe only because the task definition sets `s3`; a deployment that
  omits the variable would select R2. Variables `R2_*` remain in the schema.
- Comments in `src/` and `.env.example` still describe Railway. These are documentation-level and do not change behaviour.
- The running RDS and ElastiCache sizes differ from `terraform.tfvars` (see the pending plan). Region and encryption
  facts above are unaffected.

### A.6 Related files kept separate

`DATA-CLASSIFICATION.md`, `RETENTION-POLICY.md` and `SUBPROCESSORS.md` contain tables **generated from code**
(verified by `compliance-docs.spec.ts`) and are not merged here. `railway-to-aws-migration.md` records the move.

---

## Part B: Data residency (technical position)

**Technical position only.** It does not say that hosting anywhere is lawful and is not a statement of PDPL
compliance. Whether Ziyarati may host health data outside the Kingdom, and under which mechanism, is L1/L2 and
is unanswered.

### Facts this rests on

| Fact | Status |
|---|---|
| AWS has no Region inside Saudi Arabia (an announced Saudi Region is not generally available) | as of the plan's audit; `OV` before relying on it |
| Bahrain, UAE and Frankfurt are transfers outside the Kingdom; CloudFront edge presence in KSA is not residency | confirmed from the plan |
| PDPL conditions transfers; whether health-sector rules require in-Kingdom hosting of a clinic-management SaaS | `LC` (L1) |
| Production data stores and compute are on AWS `eu-central-1` | **Verified** (A.2) |
| Railway, R2 and Resend are not wired into the running deployment | **Verified** (A.2); deletion **not verified** (A.4) |
| Vercel (front end), OpenAI, Meta, Tap and GitHub remain third-party processors outside the account | register; locations `VC` |

### The boundary (target state)

**Inside:** D2–D7, plus D8 until its payload is verified clean: database and backups, object storage and versions,
Redis, embeddings (pgvector), runtime that handles clinical data, logs, audit tables, secrets, encryption keys.
**Outside is acceptable:** D0, D1 and verified-clean D8.
**Crossing needs a registered processor, a mechanism and minimisation:** F1–F3, F8–F11, F13, F14, F18 (Part D).
"Inside" today means *inside the AWS account in Frankfurt*, which is not inside the Kingdom.
Classes are defined in `DATA-CLASSIFICATION.md`; processors in `SUBPROCESSORS.md`.

### What enforces it

| Layer | Control | Where | Proven by | Live? |
|---|---|---|---|---|
| Plan time | `aws_region` must be a member of `approved_regions` (no default) | `modules/platform/variables.tf` | `platform.tftest.hcl` | yes (production lists `eu-central-1`) |
| Plan time | `dr_backup_region` empty or in `approved_dr_destinations` | same | same | yes (empty) |
| Plan/PR time | No region literal, no provider alias for another Region, no replication / replica / multi-Region key / CloudFront / Bedrock / log-shipping construct; workflows name no Region and refuse a non-platform `AWS_REGION` | `infra/scripts/region-gate.sh`, `.github/workflows/*` | CI `static` job | passes locally; CI run not observed |
| Apply time | A Region must be approved before any plan or apply | `region-gate.sh deploy` | CI jobs | passes locally for production; CI run not observed |
| Resource | Single-Region KMS keys; replication denied in module design | module tests | `terraform test` | single-Region resources observed |
| Organisation | SCPs: deny unapproved Regions, deny copy/replication features, deny disabling audit; no per-Region exception | `modules/org-guardrails` | `policies.tftest.hcl`, `scp-semantics.test.cjs` | **not applied** (no Organization) |
| Application | Minimiser, vision gate, WhatsApp / e-mail content policy, log and job-payload scrubbing | `src/` | `npx jest` | deployed; flags see A.4 |
| Release | `production-gate.yaml` must be evidenced before a production deploy (deferrals allowed to 2026-11-10) | `infra/scripts/production-gate.cjs enforce` | `production-gate.test.cjs` | deferrals in effect |

### What it does not do

- No SCP applies today (no Organization). Even when applied, an SCP never restricts the management account or
  service-linked roles and cannot see the Region of a service-initiated copy.
- The infrastructure controls do not reach third-party processors (Vercel, OpenAI, Meta, Tap, GitHub): their data
  handling is governed by the application-layer controls and by contracts that **do not yet exist**.
- Global control-plane services (IAM, billing, support, Route 53) work from anywhere. **No patient data in resource
  names, tags, descriptions or support cases.**
- CloudTrail is multi-Region on purpose so use of an unapproved Region is visible; it is an audit trail, not an alert path.

### Decisions that gate real data

| # | Decision | State |
|---|---|---|
| L1 | Is in-Kingdom hosting mandatory for this product? | open (`LC`) |
| L2 | Is an interim foreign Region acceptable, and under which mechanism? | open (`LC`) |
| L13 | Disaster-recovery scenario | open (`LC` + owner) |
| L14 | May the authenticated app shell be served from Vercel? | open (`LC`) |

The only recorded location statement is D-1 (2026-10-08). It put `eu-central-1` into `approved_regions` so the gate
passes; it is a **technical allow-list entry, not a legal approval**. The organisation-guardrails root deliberately
does not assume it (its `approved_regions` is empty).

---

## Part C: AWS Region strategy

This part says how the stack is parameterised so a Region can be added or moved safely; it does not choose a
Region. Choosing one is a legal decision (L1/L2, Part E).

### Current state

| Item | State |
|---|---|
| Stack Region | `eu-central-1` (D-1), in `approved_regions`; applied and running (Part A) |
| Legal approval of that location | **none recorded**; `legal-hosting-approval` is open |
| Staging | `terraform.tfvars` now points at `eu-central-1`, `approved_regions` empty: **fails closed, not deployed** |
| State | one state per Region: key `platform/<region>/terraform.tfstate`, bucket in `eu-central-1` (**Verified**) |
| Organisation SCP list | empty on purpose; not applied (no Organization) |
| Saudi Region | not available as far as known; date and service list unverified (`OV`) |
| Region literals outside the platform Region | none in Terraform or workflows; the gate enforces it |

### Rules

1. **A Region is never changed in place.** Flipping `aws_region` on an existing state destroys and recreates
   everything. Each Region gets its own state key and stack; data moves by backup/restore; DNS switches last.
2. **One allow-list.** `approved_regions` is empty by default; `aws_region` must be a member; `dr_backup_region` must
   be empty or in `approved_dr_destinations`. The organisation SCP list must be a superset of every environment's Regions.
3. **No region literal and no provider alias for another Region in Terraform** (`region-gate.sh static`). There is no
   exception. Route 53 health-check metrics exist only in us-east-1, so the external health-check alarm was
   removed rather than kept as an exception; the health check itself (a global resource) remains, unalarmed, pending
   an owner decision (see A.2/B and the monitoring note below).
4. **Per-Region recreation:** KMS keys, secrets, certificates, ECR images and SES identities are recreated per Region; none is replicated.
5. **Adding a Region** is one reviewed change touching the environment tfvars, `PLATFORM_REGION` in the workflows and
   the organisation SCP list together; the gate fails if only one moves.

**Monitoring consequence of Rule 3:** nothing can see a full `eu-central-1` outage or an internet-path/DNS failure
from outside the Region. In-Region alarms (ALB, ECS, RDS, Redis, NAT, SES, payments) are active. An independent
non-AWS uptime monitor on `https://api.ziyaratech.com/api/v1/health` is the only equivalent and is **not set up**.

### Per-Region facts for a new Region (Launch Readiness Gate)

The gate fails if a line is not evidenced from AWS's official service list or a live check **in that Region**.
Column 2 shows what 2026-10-15 evidence exists for `eu-central-1`.

| Check | `eu-central-1` evidence |
|---|---|
| RDS PostgreSQL (major version, Multi-AZ, PITR, backups) | Verified: PG 17.9, Multi-AZ, 14-day backups |
| ECS + Fargate | Verified: cluster and services exist |
| ElastiCache Valkey (TLS, Multi-AZ) | Verified |
| S3 (versioning), KMS, Secrets Manager | Verified (versioning enabled, SSE-KMS, secrets present) |
| CloudWatch Logs / alarms; CloudTrail | Verified (S3 data events not re-checked) |
| ALB, regional WAF, ACM | Verified: ALB resolves, web ACL `zt-production-api`, certificate issued |
| ECR, SQS, SNS, EventBridge, GuardDuty | Verified: all exist. IAM Access Analyzer not checked |
| SES | Verified: domain verified, DKIM success, production access on |
| AWS Backup for RDS | **Not in use**: no backup plan found (RDS native automated backups only) |
| VPC interface endpoints (`interface_endpoint_services`) | Not verified (opt-in; SES endpoint name unverified) |
| Three usable Availability Zones | Not verified |
| Service-managed storage documented as in-Region (snapshots, Performance Insights, ElastiCache snapshots) | Not verified against AWS documentation |
| Backup / DR destination decided | **No**: no cross-Region copy (L13) |
| Support / operations access terms reviewed | **No** |
| Staging stack applied and restore-drilled | **No** |
| Counsel confirms the location | **No** (L1/L2) |

### Sequence

0. Legal-independent engineering: done in this repository.
1. Production deployment to AWS `eu-central-1`: **done** (API resolves to the AWS ALB; clean deployment, not a
   data migration, per the owner statement in A.4).
2. Decommissioning of Railway, R2 and Resend **with deletion evidence**: **open** (A.4).
3. Move to a Saudi Region when one is live: Launch Readiness Gate, new stack and state key, data migration, DNS,
   decommission the interim Region.

---

## Part D: Data flows

One row per flow that moves personal data between systems, with what the **code and the live account** do about
it. It is a map, not an assessment: the legal columns are in Parts E and F, and every mechanism is **missing**
until a document exists.

Status words: **built** (implemented and tested), **built, off** (default-off or needs a deployment setting),
**open** (not built or not decided), `CV`, `VC`, `LC`, `OV` as above.

PD personal · SD sensitive identifiers · HD health · AU authentication · PY payment.

| # | Flow | Data | Leaves KSA | Processor (register id) | What the code / environment does today | Status |
|---|---|---|---|---|---|---|
| F1 | Browser → Vercel (pages) | page requests, cookies (PD, AU) | yes | `vercel` | Static/public shell. Whether the authenticated shell may be served from Vercel is L14 | open, `LC` |
| F2 | Browser → Vercel → backend `/api/*` | **every REST body** (PD, SD, HD, AU, PY) | yes | `vercel` | Direct API routing exists: with `NEXT_PUBLIC_API_BASE_URL` set the browser calls the API host and no `/api` rewrite is registered. **Whether the Vercel project sets it is not verified**; the default is the proxy | built, off; **Not verified** |
| F3 | Browser → Vercel Analytics | URL paths, device data | yes | `vercel` | Mounted on public routes only | built; `CV` that public URLs carry no identifiers |
| F4 | Browser → backend WebSocket (AI chat) | chat turns (PD, HD) | yes (API is in Frankfurt) | `aws` | Origin / Fetch-Metadata admission, guest room isolation | built; hosting open |
| F5 | Backend → PostgreSQL | system of record, embeddings | yes (`eu-central-1`) | `aws` | RDS Multi-AZ, KMS at rest, TLS, 14-day backups (**Verified**) | live; hosting decision open (L1/L2) |
| F6 | Backend → Redis / BullMQ | job payloads: recipient + variables, AI text | yes (`eu-central-1`) | `aws` | ElastiCache with in-transit and at-rest encryption (**Verified**); PII redaction for jobs; failed PII jobs kept 6 h, completed 1 h. Payloads already queued are not rewritten | live; residual gap in Part E |
| F7 | Backend → object storage | patient documents, guest attachments (PD, SD, HD) | yes (`eu-central-1`) | `aws` (S3) | `STORAGE_PROVIDER=s3`; bucket SSE-KMS, versioned, 4 objects (**Verified**). No lifecycle on current objects (L12). R2 path still in code (A.5); R2 contents not verified | live; R2 deletion **not verified** |
| F8 | Backend → OpenAI chat | prompts, turns, tool arguments and results, retrieved chunks | yes | `openai` | `AiMinimizer` tokenises names, phones, e-mails and booking refs; IDs, cards, DOB removed; tool-result allow-list. Default on. Per-tenant residency switch fails closed, off by default | built; live flags not read; vendor terms `VC` |
| F9 | Backend → OpenAI vision | guest-uploaded images | yes | `openai` | Off by default (`AI_VISION_ENABLED=false`) | built, off |
| F10 | Backend → OpenAI embeddings / batch | knowledge documents, memory text | yes | `openai` | `scrubForEmbedding` before embeddings; batch upload seam scrubs chat batches and refuses unreviewed endpoints | partly built, `CV` |
| F11 | Backend → Meta WhatsApp | phone, template variables, session text, media | yes | `meta-whatsapp` | Content policy at both send seams: variable allow-list, prohibited-pattern check, opt-in for marketing | built; consent evidence incomplete (`CV`) |
| F12 | Meta → backend webhook | inbound messages, media | inbound | `meta-whatsapp` | HMAC verified; classified D4 on arrival, kept inside the boundary | built |
| F13 | Backend → Tap | payer name/contact, amount; card entered on Tap's page | `VC` | `tap` | Only Tap ids, brand, scheme and last four stored; no card number or CVV. `PAYMENT_PROVIDER=tap`, `TAP_ENV=live` in the running task | live; booking payments flag set false in tfvars |
| F14 | Backend → e-mail provider | recipient, subject, body variables | yes | `aws` (SES) | `EMAIL_PROVIDER=ses`, domain verified (**Verified**). The Resend code path was removed 2026-10-17 (SES is the only provider). Minimal appointment notices; identifiers redacted from free text | live; real-inbox delivery not verified |
| F15 | Backend → logs | request metadata, errors, `failedReason` | yes (`eu-central-1`) | `aws` | CloudWatch Logs, KMS, 30-day retention on application groups (**Verified**); redacting logger and scrubbers; no bodies, tokens, prompts or message text. DLQ `originalData` is the replay payload, kept until its stamped expiry (WhatsApp DLQ 6 h; other DLQs ids only) | live |
| F16 | DB → backups | full database | yes (`eu-central-1`); no DR copy | `aws` | RDS automated snapshots (8 found, **Verified**); no AWS Backup plan; backup copy only into `approved_dr_destinations` (empty) | live; DR open (L13) |
| F17 | AWS → `us-east-1` | — | — | — | **Removed 2026-10-15**: no alarm, topic or subscription exists in `us-east-1` (**Verified**) | closed |
| F18 | CI → AWS | images, plans, state reads | yes | `github` | OIDC, no patient data in CI; plan artifacts treated as D6 | built; `CV` |

### Not on the map yet

- Tenant-configured outbound integrations (clinic-chosen webhook and partner endpoints): the clinic is the
  controller of that transfer; destinations are SSRF-guarded (`tenant-configured`).
- Marketplace patient accounts and the public booking flow: classified in `DATA-CLASSIFICATION.md`; the
  controller/processor split is L9.
- Support cases with AWS or any vendor: no patient data may go in them (a rule, not a technical control).
- Former hosts (Railway, R2, Resend): no flow remains in the running deployment; residual copies, if any, are
  unknown (A.4).

### Keeping it true

A new outbound call, vendor SDK or hostname fails `subprocessor-egress.spec.ts` until it is in the register; a new
table fails `data-classification.spec.ts` until classified. This file is written by hand: when a flow row changes,
change the code and this table in the same pull request.

---

## Part E: PDPL status register

**A status register, not a compliance claim.** The repository cannot establish compliance with the Personal Data
Protection Law or any sector rule; that needs counsel and the regulators' texts. Several instruments could not be
read (`OV`). Article numbers and deadlines are deliberately **not** quoted because none has been verified against
the official text.

### 1. Instruments

| Id | Instrument | Applies to Ziyarati | Status |
|---|---|---|---|
| R1 | Personal Data Protection Law (SDAIA) | yes, as a processor of personal data of people in KSA | applicability confirmed; detail `OV` |
| R2 | PDPL Implementing Regulation (health-data controls, processor duties, records, breach notice, DPIA, DPO) | yes | `OV` |
| R3 | Regulation on Personal Data Transfer outside the Kingdom | yes, today (AWS Frankfurt, Vercel, OpenAI, Meta, Tap, SES) | `OV` |
| R4 | Standard Contractual Clauses for transfer | where relied on | `OV` |
| R5 | Risk Assessment Guideline for transfers | where relied on | `OV` |
| R6 | NHIC Telehealth Application Guidelines (in-Kingdom storage sentence) | text confirmed; binding force and scope for a non-telehealth SaaS `LC` | `LC` |
| R7 | Saudi Health Information Exchange Policies IS0303 | exchange participants and their associates; triggered by NPHIES integration | `LC` |
| R8 | MoH / CHI rules for licensed facilities' records | not located | `OV` + `LC` |
| R9–R10 | NCA ECC-2:2024, CCC-2:2024 | direct or only through customer contracts | `LC` |
| R11 | CST Cloud Computing Services Provisioning Regulations | registration for a SaaS | `LC` |
| R12 | NDMO data governance | government customers only | `LC` |
| R13 | SAMA payment rules | indirect via Tap | `VC` |

### 2. Obligation areas and what exists

"Technical control" means a mechanism that supports the duty, not that the duty is met.

| Area | Technical control | Where | Still outstanding |
|---|---|---|---|
| Records of processing | Table classification, flow map, subprocessor register | `DATA-CLASSIFICATION.md`, Part D, `SUBPROCESSORS.md` | Counsel's format; DPIA export not built; **register still lists Railway/R2/Resend as active and AWS as planned** (A.5) |
| Lawful basis, consent | Customer consent state; WhatsApp marketing needs recorded opt-in | `Customer` consent migration, `whatsapp-content-policy.ts` | Wording and basis (L11); consent evidence per channel incomplete (`CV`) |
| Data minimisation | AI minimiser, vision gate, WhatsApp/e-mail policy, job-payload redaction, log scrubbing | Part D F6–F15 | Batch guard covers the chat endpoint only; queued payloads already in Redis; DLQ `originalData` kept un-minimised for replay and expires on a stamped deadline |
| Transfers | Register, egress allow-list test, per-flow feature flags | `SUBPROCESSORS.md` | **No DPA, SCC or risk assessment for any processor** (Part F). The platform itself is a transfer to Frankfurt (L2) |
| Access control | Tenant isolation, RBAC, platform-admin audit | application | D4 read-audit status `CV` |
| Security | Encryption at rest and in transit, WAF, GuardDuty, CloudTrail, private subnets (**deployed**, A.2) | `AWS-SECURITY.md` | SCPs not applied (no Organization); penetration test not done |
| Data-subject rights | Request intake, export, erase, restrict, close; evidence record | `privacy/requests` | Statutory time limits and identity-verification rules (`OV`) |
| Retention and deletion | Retention engine with no built-in values; patient erase; tenant offboarding | `RETENTION-POLICY.md` | L12; backups, Redis and processor copies are not reached by deletion; **deletion from former hosts not evidenced** |
| Breach handling | Runbook scaffold | `INCIDENT-RESPONSE.md` | Notification deadline and recipients (`OV`/`LC`); contacts; an exercise |
| DPO / controller registration | none | – | L5 |
| Residency | Region allow-list and gate (live), SCPs (written, not applied), copy denies, release gate (deferrals in effect) | Parts B–C | L1, L2; the Saudi Region is not available |

### 3. Open legal questions

| # | Question | Blocks |
|---|---|---|
| L1 | Is in-Kingdom hosting of health data mandatory for a clinic-management SaaS? Which instrument and article? | any hosting of real data |
| L2 | Is an interim foreign Region acceptable, and under which mechanism? | production (already running in Frankfurt) |
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
| L13 | Disaster-recovery scenario (no cross-Region copy exists) | production |
| L14 | May the authenticated app shell be served from Vercel? | Part B |

### 4. Rule for this file

A row changes status only when the evidence named in it exists (a document, a test, a record) and the change is
reviewed. Do not write "compliant", "certified" or an article number here without the official text and counsel's
confirmation.

---

## Part F: Transfer impact assessment (worksheet)

**A worksheet with the factual columns filled from the repository and the live account, and every legal column
left open.** No conclusion is drawn: whether a transfer is permitted, which safeguard applies and whether a risk
assessment is mandatory are `LC` (L2, L10). The SDAIA transfer regulation, SCCs and risk-assessment guideline were
not read (`OV`); take the criteria from the official texts, not from this file.

### Gate per flow

A flow that leaves the Kingdom may run in production only when **all five** are evidenced; otherwise it is
disabled by feature flag, not left running. Today the platform runs while gates 1–4 are **missing** for every flow:
that is a known, open exposure (L2), not a resolved position.

1. Legal basis (L11)
2. DPA evidence (`SUBPROCESSORS.md`)
3. SCC evidence, or counsel's written alternative (L10)
4. Transfer risk assessment, where counsel says it is required
5. The minimisation control named in Part D

### Worksheet

Facts are from Part D and `SUBPROCESSORS.md`. A blank cell is open. Gates 1–4 are **missing** for every row: no
DPA, SCC, assessment or legal basis document is held in this repository.

| Flow | Processor | Data classes | Health data | Volume / frequency | Minimisation (gate 5) | Off switch if gates are missing | 1 basis | 2 DPA | 3 SCC | 4 risk assessment |
|---|---|---|---|---|---|---|---|---|---|---|
| F5–F7, F14–F16 hosting, storage, logs, backups, SES | AWS (`eu-central-1`) | D2–D8 | yes | | encryption (KMS), single-Region keys, no replication | none short of stopping the service | | | | |
| F1–F2 pages and REST | Vercel | D2, D4, D6 | yes | | direct API routing (built; **setting not verified**) | set `NEXT_PUBLIC_API_BASE_URL`; REST leaves Vercel | | | | |
| F3 analytics | Vercel | D1 | no (public pages only) | | public routes only | remove `PublicAnalytics` | | | | |
| F8 AI chat | OpenAI | D2, D4 | yes | | `AiMinimizer` | `AI_MINIMIZER_ENABLED` is a safety switch, **not** an off switch; disable the AI feature per tenant/plan | | | | |
| F9 AI vision | OpenAI | D2, D3, D4 | yes | | off by default | `AI_VISION_ENABLED=false` | | | | |
| F10 embeddings / batch | OpenAI | D2, D4 | possible | | `scrubForEmbedding`; batch seam scrubs chat batches | disable knowledge ingestion / batch jobs | | | | |
| F11 WhatsApp | Meta | D2 | possible | | content policy at both send seams | disable the WhatsApp channel per tenant | | | | |
| F13 payments | Tap | D2, D5 | no | | hosted page; no card data stored | disable online payment | | | | |
| F14 e-mail | AWS SES (only provider; Resend code removed 2026-10-17) | D2 | possible | | minimal notices, free-text redaction | `EMAIL_ENABLED=false` | | | | |
| Former hosts | Railway, Cloudflare R2, Resend | D2–D8 (if any data was held) | unknown | | none; **deletion not evidenced** | obtain written deletion confirmation | | | | |

### Risk-assessment inputs (to hand to counsel)

For each flow counsel decides to assess, the technical inputs available are: the data classes above, the
field-level allow-lists and redaction code named in Part D, the vendor's Region / retention / sub-processor answers
once obtained (`VC`), encryption in transit (TLS) and at rest where applicable, the verified AWS configuration in
Part A, and the DPIA inventory (`DATA-CLASSIFICATION.md`; the export tool is not built).

Sign-off for each row: assessor, date, outcome, review date. Record it in the contract repository and reference it
from `compliance/production-gate.yaml` (`scc-or-alternative`); do not commit privileged opinions to this repository.
