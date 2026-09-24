# ZiyaraTech AWS infrastructure

Backend on AWS (ECS Fargate, RDS PostgreSQL, ElastiCache Valkey, S3, SES), with the frontend staying on Vercel.

| Read | For |
|---|---|
| [docs/CURRENT-STATE-AUDIT.md](docs/CURRENT-STATE-AUDIT.md) | what exists today and the findings that shaped the design |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Phase 1 / 2 / target, DB + Redis decisions, connection budget, diagrams |
| [docs/AWS-SERVICES.md](docs/AWS-SERVICES.md) | why every service exists, and what was rejected |
| [docs/SCALING-ROADMAP.md](docs/SCALING-ROADMAP.md) | metric → threshold → action |
| [docs/SECURITY.md](docs/SECURITY.md) | IAM, secrets, WAF, tenant isolation, privacy, verification checklist |
| [docs/DISASTER-RECOVERY.md](docs/DISASTER-RECOVERY.md) | RPO/RTO and runbooks |
| [docs/COST-MODEL.md](docs/COST-MODEL.md) | Phase 1–3 cost ranges and their assumptions |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | CI/CD, task-definition ownership, rollback |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Railway / R2 / Resend → AWS runbook and checklist |
| [docs/TERRAFORM.md](docs/TERRAFORM.md) | layout, state, workflow, tests |

**Decisions needed before production go-live:**
- **D-1:** data residency and DR region
- **D-2:** a separate staging domain
- **D-3:** AWS Organizations accounts

**Payments go-live gate:** REL-002/003/005/009/011 from the 2026-09 reliability audit is still open.
