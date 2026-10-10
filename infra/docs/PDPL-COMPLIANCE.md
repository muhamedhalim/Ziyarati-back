# PDPL status register

Residency plan sections 3, 4, 23, 24. **This is a status register, not a compliance claim.** The repository cannot establish compliance with the Personal Data Protection Law or any sector rule; that needs counsel and the regulators' texts. Several instruments below could not be read from the build environment (`OV`). Article numbers and deadlines are deliberately **not** quoted anywhere in this repository because none has been verified against the official text.

Status vocabulary: `C` confirmed from the repo or an official source read directly · `OV` needs official verification · `LC` needs Saudi legal counsel · `VC` needs vendor confirmation · `CV` needs code verification.

## 1. Instruments

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

## 2. Obligation areas and what exists in the repository

"Technical control" means a mechanism that supports the duty. It does not mean the duty is met; each row's last column says what is still outstanding.

| Area | Technical control in the repository | Where | Still outstanding |
|---|---|---|---|
| Records of processing | Table classification, flow map, subprocessor register | `DATA-CLASSIFICATION.md`, `DATA-FLOW.md`, `SUBPROCESSORS.md` | Counsel's format; DPIA export (P16) not built |
| Lawful basis, consent | Customer consent state; WhatsApp marketing needs recorded opt-in | `Customer` consent migration, `whatsapp-content-policy.ts` | Wording and basis (L11); consent evidence per channel is incomplete (`CV`) |
| Data minimisation | AI minimiser, vision gate, WhatsApp / e-mail content policy, job-payload redaction, log scrubbing | `DATA-FLOW.md` F6-F15 | Batch-job guard covers the chat endpoint only (embeddings batches are clinic knowledge content, embedded as written like the sync path); queued payloads already in Redis; DLQ `originalData` is kept un-minimised on purpose (replay needs it) and expires on a stamped deadline (WhatsApp DLQ 6 h, the other three DLQs carry ids only) |
| Transfers | Register, egress allow-list test, per-flow gating by feature flag | `SUBPROCESSORS.md` | **No DPA, SCC or risk assessment for any processor** (`TRANSFER-IMPACT-ASSESSMENT.md`) |
| Access control | Tenant isolation, RBAC, platform-admin audit | application | D4 read-audit (P14) status `CV` |
| Security | Encryption at rest and in transit, WAF, GuardDuty, CloudTrail, SCPs, private subnets | `AWS-SECURITY.md` | Nothing applied; penetration test not done |
| Data-subject rights | Request intake, export, erase, restrict, close; evidence record | `privacy/requests` (`data-subject-request.*`) | Statutory time limits and identity-verification rules (`OV`) |
| Retention and deletion | Retention engine with no built-in values; patient erase; tenant offboarding | `RETENTION-POLICY.md` | L12; backups, Redis and processor copies are not reached by deletion |
| Breach handling | Runbook scaffold | `INCIDENT-RESPONSE.md` | Notification deadline and recipients (`OV`/`LC`); contacts; an exercise |
| DPO / controller registration | none | - | L5 |
| Residency | Region allow-list, SCPs, copy denies, release gate | `DATA-RESIDENCY.md` | L1, L2; the Saudi Region is not available |

## 3. Open legal questions (from the plan)

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

## 4. Rule for this file

A row changes status only when the evidence named in it exists (a document, a test, a record) and the change is reviewed. Do not write "compliant", "certified" or an article number here without the official text and counsel's confirmation.
