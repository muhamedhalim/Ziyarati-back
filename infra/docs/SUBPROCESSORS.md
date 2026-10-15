# Subprocessors and third parties

Residency plan section 18. **An inventory, not evidence.** No DPA, SCC, transfer risk assessment, subprocessor list or breach-process document for any provider is held in this repository, and nothing here says one exists. Region and retention are `VC` (needs vendor confirmation) until a written vendor answer is recorded.

The table below is **generated** from `src/modules/data-governance/subprocessor-register.ts`. Edit the register, then run:

```bash
UPDATE_COMPLIANCE_DOCS=1 npx jest compliance-docs
```

`subprocessor-egress.spec.ts` ties the register to the code: a hostname literal, an outbound-call file or a vendor SDK dependency that is not accounted for fails the build, so a new processor cannot be added without being written down.

<!-- BEGIN GENERATED: subprocessors -->
| Id | Processor | State | Data classes | Health data | Flows | Region | Retention | Ziyarati-side control | Evidence still to obtain |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI | active | D2, D4 | yes | F8, F9, F10 | VC | VC (zero-retention option not evidenced) | AI minimiser (names/phones/emails tokenised; IDs, cards, DOB removed); vision off by default | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `meta-whatsapp` | Meta (WhatsApp Business Cloud API) | active | D2 | no | F11, F12 | VC (local storage option does not list Saudi Arabia - OV) | VC | WhatsApp content policy at both send seams; marketing needs recorded opt-in | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `tap` | Tap Payments | active | D2, D5 | no | F13 | VC | VC | No card number or CVV ever enters this system; hosted payment page only | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `resend` | Resend | active | D2 | no | F14 | VC | VC | Minimal appointment notices (no service, doctor or reason); identifiers redacted from free text | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `aws` | Amazon Web Services | planned | D2, D3, D4, D5, D6, D7, D8 | yes | F5, F6, F7, F14, F15, F16, F17 | Not decided - no KSA Region exists; see the residency plan and L1/L2 | Configured by us (backups 14 days planned; clinical retention undefined - L12) | Region allow-list, single-Region keys, replication denied, SCPs (written, not applied) | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `cloudflare-r2` | Cloudflare R2 | active | D2, D4 | yes | F7 | VC | Indefinite (no lifecycle policy) | To be replaced by S3 in the approved Region; deletion evidence required afterwards | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `railway` | Railway | active | D2, D3, D4, D5, D6, D7, D8 | yes | F5, F6, F15, F16 | VC | VC | Infrastructure host; no code path calls it. To be decommissioned with deletion evidence. | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `vercel` | Vercel | active | D2, D4, D6 | yes | F1, F2, F3 | VC | VC (logs) | Direct API routing removes REST from the path; analytics limited to public pages | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `github` | GitHub | active | D1, D6 | no | F18 | VC | Artifacts per repository policy | No patient data in CI; Terraform plan artifacts are treated as D6 | dpa, scc, transferRiskAssessment, subprocessorList, breachProcess |
| `tenant-configured` | Clinic-configured partner endpoints | tenant_configured | D2 | no | - | Chosen by the clinic | Chosen by the clinic | SSRF-guarded destinations; the clinic is the controller of that transfer | n/a (clinic is the controller) |
<!-- END GENERATED: subprocessors -->

## Rules

- A provider that is not in the register may not be called from production code (enforced by the egress spec).
- A field moves off `to_obtain` only by a reviewed change that names the document in `evidence`. The production gate (`compliance/production-gate.yaml`) refuses to mark `dpa-critical-processors`, `scc-or-alternative` or `transfer-inventory-complete` satisfied while the register still lists that evidence as missing (`compliance-docs.spec.ts`).
- `tenant_configured` rows are destinations a clinic chooses (webhooks, integrations). The clinic is the controller of that transfer; the destination is data, so it cannot be listed.
- Statuses of `legacy` / `planned` rows are decommissioning and hosting decisions, not endorsements. Railway, Cloudflare R2 and Resend need **deletion evidence** after migration (`Ziyarati-back/infra/runbooks/railway-to-aws-migration.md (Part D)`).

## What to collect per processor (plan section 18)

Purpose and data categories · storage and processing region · DPA · SDAIA SCC or counsel's written alternative · transfer risk assessment where counsel requires one · subprocessor list · retention and deletion terms · breach-notification process · support-access terms · certifications · residency options. Legal questions this feeds: L10, L11 (`Ziyarati-back/infra/docs/DATA-RESIDENCY.md (Part E)`).
