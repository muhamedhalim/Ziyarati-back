# Data residency

Residency plan sections 1, 7, 12, 15. **Technical position only.** It does not say that hosting anywhere is lawful and it is not a statement of PDPL compliance. Whether Ziyarati may host health data outside the Kingdom, and under which mechanism, is L1/L2 and is unanswered.

## Facts this rests on

| Fact | Status |
|---|---|
| AWS has no Region inside Saudi Arabia today (an announced Saudi Region is not generally available) | `C` as of the plan's audit; re-check with the AWS Regions page before relying on it (`OV`) |
| Bahrain, UAE and Frankfurt are transfers outside the Kingdom; CloudFront edge presence in KSA is not residency | `C` |
| PDPL conditions transfers; whether health-sector rules require in-Kingdom hosting of a clinic-management SaaS | `LC` (L1) |
| Production runs today on Railway, Cloudflare R2, Resend and Vercel | `CV` against live settings |
| Nothing in `infra/terraform` has ever been applied | `C` |

## The boundary (target state)

**Inside:** D2-D7, plus D8 until its payload is verified clean: database and backups, object storage and versions, Redis, embeddings (pgvector), runtime that handles clinical data, logs, audit tables, secrets, encryption keys.
**Outside is acceptable:** D0, D1, and verified-clean D8.
**Crossing needs a registered processor, a mechanism and minimisation:** F1-F3, F8-F11, F13, F14, F18 (`DATA-FLOW.md`).
Classes are defined in `DATA-CLASSIFICATION.md`; processors in `SUBPROCESSORS.md`.

## What enforces it (all written and tested; **none applied**)

| Layer | Control | Where | Proven by |
|---|---|---|---|
| Plan time | `aws_region` must be a member of `approved_regions` (no default; empty until approved) | `modules/platform/variables.tf` | `platform.tftest.hcl` |
| Plan time | `dr_backup_region` must be empty or in `approved_dr_destinations` | same | same |
| Plan time | No region literal and no replication / replica / multi-Region key / CloudFront / Bedrock / log-shipping construct in Terraform | `infra/scripts/region-gate.sh static` | CI `static` job |
| Plan time | Environment regions must sit inside the organisation SCP region list | `region-gate.sh` (`check_org_guardrails`) | CI `static` job |
| Apply time | A Region must be approved before any plan or apply | `region-gate.sh deploy` | `plan` / `preview` / `apply` jobs |
| Resource | Single-Region KMS keys; S3 replication denied; RDS no replica / backup replication; Valkey no global datastore; no secret replicas | module tests | `terraform test` per module |
| Organisation | SCPs: deny unapproved Regions (global control plane exempt; `us-east-1` health-check exception only), deny copy/replication features, deny disabling audit | `modules/org-guardrails`, `environments/org-guardrails` | `policies.tftest.hcl`, `scp-semantics.test.cjs` |
| Application | Minimiser, vision gate, WhatsApp / e-mail content policy, log and job-payload scrubbing | `src/` (see `DATA-FLOW.md`) | `npx jest` |
| Release | `compliance/production-gate.yaml` must be fully evidenced before a production deploy or apply | `infra/scripts/production-gate.cjs enforce` | `production-gate.test.cjs` |

## What it does not do

- An SCP never restricts the management account or service-linked roles, cannot see the Region of a service-initiated copy, and cannot constrain SNS subscriptions, EventBridge targets or in-account sharing (`runbooks/org-guardrails-rollout.md` section 2).
- None of the infrastructure controls protects data that is **not** on AWS. Today that is everything: the live data is on Railway / R2 / Resend / Vercel and is governed by the application-layer controls only.
- Global control-plane services (IAM, billing, support, Route 53) keep working from anywhere. **No patient data in resource names, tags, descriptions or support cases.**
- The `us-east-1` exception exists only for the Route 53 health-check alarm and its SNS topic. Its text must stay free of tenant or patient fields.

## Decisions that gate real data

| # | Decision | State |
|---|---|---|
| L1 | Is in-Kingdom hosting mandatory for this product? | open (`LC`) |
| L2 | Is an interim foreign Region acceptable, and under which mechanism? | open (`LC`) |
| L13 | Disaster-recovery scenario | open (`LC` + owner) |
| L14 | May the authenticated app shell be served from Vercel? | open (`LC`) |

The only recorded location statement is the owner's 2026-10-08 chat decision (D-1), which put `eu-central-1` in `approved_regions` in `environments/production/terraform.tfvars` so the region gate passes. That is a **technical allow-list entry, not a legal approval**: the production-gate item `legal-hosting-approval` stays open until written advice exists, and the organisation-guardrails root deliberately does not assume it (its `approved_regions` is empty). See `AWS-REGION-STRATEGY.md`.
