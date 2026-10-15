# ZiyaraTech AWS infrastructure

Backend on AWS (ECS Fargate, RDS PostgreSQL, ElastiCache Valkey, S3, SES), with the frontend staying on Vercel.

Last revised 2026-10-15. The documents under `docs/` were consolidated on that date (one file per topic);
each begins with a **Part A: Current state and verification** that separates what is live, what is only
committed, and what is not verified.

## Read

| Read | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | design (Phase 1 / 2 / target, DB + Redis, connection budget) **and** the AWS service decision matrix; Part A compares the design with what is deployed |
| [docs/INFRASTRUCTURE-AUDITS.md](docs/INFRASTRUCTURE-AUDITS.md) | pre-migration current-state audit, Well-Architected review, live AWS audit, audit evidence |
| [docs/SECURITY.md](docs/SECURITY.md) | IAM, secrets, WAF, tenant isolation, privacy, verification checklist |
| [docs/AWS-SECURITY.md](docs/AWS-SECURITY.md) | map from each boundary control to its module, test and runbook |
| [docs/DATA-RESIDENCY.md](docs/DATA-RESIDENCY.md) | residency position, region strategy, data flows, PDPL status register, transfer-impact worksheet |
| [docs/DATA-CLASSIFICATION.md](docs/DATA-CLASSIFICATION.md), [docs/RETENTION-POLICY.md](docs/RETENTION-POLICY.md), [docs/SUBPROCESSORS.md](docs/SUBPROCESSORS.md) | tables **generated from code** and checked by `compliance-docs.spec.ts` (do not merge or hand-edit the generated blocks) |
| [docs/DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md) | RPO/RTO targets and restore runbooks |
| [docs/INCIDENT-RESPONSE.md](docs/INCIDENT-RESPONSE.md) | personal-data breach and security incident scaffold |
| [docs/SCALING.md](docs/SCALING.md) | metric → threshold → action roadmap and the live autoscaling review |
| [docs/COST.md](docs/COST.md) | cost model, measured estimate, forensics, optimization plan/results, RDS right-sizing |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | CI/CD pipelines, task-definition ownership, rollback, and the CI/CD workflow audit |
| [docs/TERRAFORM.md](docs/TERRAFORM.md) | layout, state, workflow, tests |
| [runbooks/railway-to-aws-migration.md](runbooks/railway-to-aws-migration.md) | Railway / R2 / Resend → AWS: plan, DNS cutover, superseded data-migration runbook |
| [runbooks/org-guardrails-rollout.md](runbooks/org-guardrails-rollout.md) | organisation SCP rollout procedure (cited by `compliance/production-gate.yaml`) |
| [runbooks/tap-payments-rollout.md](runbooks/tap-payments-rollout.md) | Tap payments production rollout procedure |

Files whose paths other tooling depends on were kept: `docs/SECURITY.md` and `docs/DISASTER-RECOVERY.md`
(named as evidence in `infra/scripts/tests/production-gate.test.cjs`), `docs/ARCHITECTURE.md`,
`docs/DEPLOYMENT.md`, `docs/TERRAFORM.md` (cited in workflow headers), the three generated-table documents, and the
runbooks named by the production gate.

## Decisions needed before production go-live

- **D-1:** data residency and DR region (stack runs in `eu-central-1` by the owner's 2026-10-08 decision; the legal question is open — see `docs/DATA-RESIDENCY.md`)
- **D-2:** a separate staging domain
- **D-3:** AWS Organizations accounts

**Payments go-live gate:** REL-002/003/005/009/011 from the 2026-09 reliability audit is still open.
