# ADR: Integration Platform module boundaries (Phase 3 → Phase 4)

- **Status:** Proposed (awaiting ratification before structural change)
- **Date:** 2026-07-23
- **Context:** Phase 3 added the write half of the two-way integration platform across
  three modules (`platform`, `integration`, `integration-platform`). Before building the
  remaining two-way features (async import, sync engine, persistent conflicts, inbound
  webhooks, provider/OAuth abstraction), we must decide whether those three modules stay
  separate, merge, or reorganize.

This ADR is **code-derived** — every claim below was checked against the actual source, not
the prior implementation report.

---

## 1. Current structure (as built)

### `modules/platform` — shared platform **infrastructure** (no business domain)
`api-key.*`, `api-log.*`, `webhook-endpoint/delivery/log/*` (outbound webhooks, Phase 2),
`file-upload.*`, `system-setting.*`, `platform-maintenance.*`,
`integration-scopes.constants.ts`, and the guards `ApiKeyAuthGuard`, `IntegrationScopeGuard`,
`MaintenanceGuard`. It has **zero dependency on any business-domain module**. It owns the
**machine-to-machine authentication/authorization primitives** (API-key hashing → active →
expiry → tenant status → integration scopes → per-key rate limit) and exports the guards +
scope helpers other modules reuse.

### `modules/integration` — external **machine-to-machine API surface** (thin controllers)
`integration-{services,staff,customers,appointments,availability}.controller.ts` (read, Phase 1)
and `integration-write-{customers,services}.controller.ts` (write, Phase 3), plus
`integration.mappers.ts` (strict read allowlist projections). **No services of its own.** Every
route is `@ApiKeyProtected(scope)` and delegates to an existing domain service or to the shared
write pipeline. Mounted at `/api/v1/integrations/*`.

### `modules/integration-platform` — integration **application core + tenant-facing management** (Phase 3)
`integration-connection.*` (lifecycle, encrypted credentials), `integration-id-map.*`
(external↔internal mapping), `integration-idempotency.*` (retry-safe writes),
`source-of-truth.ts` (protected-field / conflict-policy engine), `integration-upsert.service.ts`
(the one write pipeline), `integration-import.service.ts` (bounded sync import),
`integration-write.service.ts` (M2M write orchestrator, **exported**), `integration-audit.service.ts`.
Two tenant-facing controllers mounted at `/platform/integrations/*` guarded by
`PermissionsGuard + ActiveTenantGuard` using `platform.integrations.{read,manage}` permissions.
Depends on `CryptoModule`, `CrmModule`, `ServicesModule`.

### Verified dependency direction (acyclic)

```
        modules/platform  (infra + M2M auth/scopes; no domain deps)
              ▲
              │ imports (auth guards, scopes)
              │
   modules/integration ───imports───► modules/integration-platform
   (thin M2M controllers)             (write pipeline + tenant mgmt)
              │                                │
              │ imports (domain)               │ imports (domain)
              ▼                                ▼
        crm / services / staff / appointment / scheduling  (domain)
```

- No business-domain module imports any integration module (checked: `crm`, `services`,
  `staff`, `appointment`, `scheduling` — none reference `integration*`).
- `platform` imports **no** domain and **no** integration module.
- `integration-platform` imports **no** `platform` and **no** `integration` (it takes only
  `CryptoModule` + domain modules).
- There is **exactly one mutation path**: `IntegrationWriteService` → `IntegrationUpsertService`
  → domain `CustomerService`/`ServiceService`. Both the tenant-facing importer and the external
  M2M write controllers go through it. The two repositories injected into the upsert service are
  used for **read-only** dedupe/`currentView` lookups only — no direct domain writes.

---

## 2. Problems found

| # | Problem | Severity | Evidence |
|---|---------|----------|----------|
| P1 | **Naming collision / unclear ownership.** Three modules carry "platform"/"integration" in their names; the write pipeline lives in `integration-platform` but its M2M controllers live in `integration`, and the tenant routes are `platform/integrations/*`. A newcomer must jump across three folders to trace one write. | Medium | folder + route/permission namespace mismatch |
| P2 | **Flat folder won't scale.** `integration-platform` is a flat directory of ~16 files. Phase 4 adds async import jobs, a sync engine, conflict persistence, inbound webhooks, and provider adapters — that is another 25–40 files with no internal seams. | High (forward-looking) | directory listing |
| P3 | **Scattered integration constants.** Scope→permission mapping lives in `platform/integration-scopes.constants.ts`; resource/conflict/provider constants live in `integration-platform/integration-platform.constants.ts`. Two homes for "what an integration may do." | Low | two constants files |
| P4 | **`onDelete: 'CASCADE'` on `IntegrationIdMap`/`IdempotencyKey` → `IntegrationConnection`.** Safe **today** only because disconnect is a soft-delete (`deleted_at`), so rows are never hard-deleted. But the FK contradicts the stated "mappings/history must survive disconnect" intent if a hard delete is ever introduced. | Low–Medium | entities + migration |
| P5 | **Idempotency key bound to `(tenant, key)` only** — not connection/route. Endpoint is stored but not part of uniqueness. Cross-connection key reuse collapses to a payload-mismatch 422 rather than being cleanly scoped. | Low | `IntegrationIdempotencyKey` unique index |

**Explicitly NOT problems (verified false):** no duplicated mutation pipeline; no duplicated
auth/authz logic (M2M via `platform` guards, tenant via `auth` guards — two audiences, one
implementation each); no circular dependency; controllers depend on the correct (application)
layer.

---

## 3. Options considered

### Option A — Merge everything into `modules/platform`
- **Reject.** `platform` is deliberately infrastructure with **zero** domain dependencies. The
  integration write pipeline depends on `CrmModule`/`ServicesModule` (and will grow to
  `StaffModule`/`AppointmentModule`). Merging drags heavy domain deps into the infra module,
  turns it into an 80+ file god-module, and mixes tenant-facing integration management with
  pure platform infra. This is "merge to reduce folders," which the brief explicitly warns
  against.

### Option B — Keep `integration-platform` separate exactly as-is
- **Partially accept.** The boundaries and dependency direction are already correct, so keeping
  the separation is right. But leaving it a flat folder does nothing for P1/P2/P3 and will rot
  as Phase 4 lands.

### Option C — One clear bounded context; keep external M2M controllers thin in `integration`
- **Accept (adapted to repo conventions).** The brief's literal shape is
  `modules/platform/integrations/{connections,mappings,imports,sync,conflicts,providers}`. This
  repo, however, expresses platform sub-domains as **sibling hyphenated top-level modules**
  (`platform-finance`, `platform-monitoring`, `platform-usage`, `platform-ai-monitoring`) — it
  does **not** nest `modules/platform/<x>/`. So the faithful, repo-idiomatic form of Option C is:
  keep `integration-platform` as the top-level bounded-context module and give it the
  `connections/ mappings/ imports/ sync/ conflicts/ providers/ write/ webhooks/` **internal**
  sub-structure, while keeping `integration` as the thin M2M surface and `platform` as shared
  infra/auth.

---

## 4. Decision

**Adopt Option C, adapted to repo conventions = "retain the three-module separation, keep the
external surface thin, and give the integration bounded context internal cohesion."**

Concretely:

1. **`modules/platform` — unchanged in role.** Remains shared infrastructure + the M2M
   auth/authorization primitives (`ApiKeyAuthGuard`, `IntegrationScopeGuard`,
   `integration-scopes.constants.ts`, outbound webhooks, settings, file upload, maintenance).
   `integration-scopes.constants.ts` **stays here** because it is bound to API-key issuance and
   validation (the auth layer); moving it would either invert the dependency
   (`platform → integration-platform`) or duplicate it. (Addresses P3 by *documenting* the split
   rather than forcing a bad dependency.)

2. **`modules/integration` — unchanged in role, kept thin.** The external machine-to-machine API
   surface. Read + write controllers only; no business logic. Phase 4's **inbound webhook
   controllers** land here too (still thin, delegating to the shared pipeline).

3. **`modules/integration-platform` — reorganized internally into sub-domains** as Phase 4
   features land:
   ```
   integration-platform/
     connections/     ← connection.{entity-facing service,controller,dto}, health, providers wiring
     mappings/        ← id-map service + mappings controller
     write/           ← upsert + write-orchestrator + source-of-truth (the ONE mutation path)
     idempotency/     ← idempotency service
     imports/         ← import job entity/service/controller + async processor glue
     sync/            ← sync job/run entities, engine, cursor, scheduler glue
     conflicts/       ← persistent conflict entity/service/controller
     providers/       ← provider abstraction + adapter interfaces (+ OAuth when a real provider exists)
     webhooks/        ← inbound-webhook verification + queue enqueuer (controllers stay in `integration`)
     integration-platform.constants.ts, integration-platform.module.ts
   ```
   The **existing** flat files move into `connections/`, `mappings/`, `write/`, `idempotency/`,
   `imports/` in the same pass so the module is internally consistent from day one.

4. **Optional, deferred — rename `integration-platform` → `platform-integrations`** to match the
   `platform-*` sibling convention **and** the existing `platform.integrations.*` route/permission
   namespace. **Recommended to defer**: it is pure churn (breaks every import path, muddies git
   blame) with no runtime benefit, and the internal sub-structure delivers the real value. Revisit
   only if the naming confusion (P1) proves costly.

We do **not** merge into `platform` (reject A) and we do **not** leave the flat folder (reject
pure B). Async import, sync, and inbound webhooks **reuse the existing BullMQ infrastructure**
(`QueueModule` producers + `worker.module.ts` processors, mirroring `webhook-delivery.processor`)
— no new queue framework.

---

## 5. Why it fits the existing architecture

- **Matches the repo's module idiom** — bounded contexts are top-level modules; platform
  sub-domains are hyphenated siblings, internal layering is by sub-domain folder. (`payments`,
  `ai`, `whatsapp` are already 38–50-file modules with internal structure.)
- **Preserves the already-correct dependency direction** — infra ← external-surface →
  application-core → domain, acyclic, with domain modules ignorant of integrations.
- **Keeps the single mutation path** — every new inbound path (async import worker, inbound
  webhook, sync engine) is required by the structure to call `write/` (the exported
  `IntegrationWriteService`/`IntegrationUpsertService`), never a second mutation implementation.
- **Reuses existing platform primitives** — API-key auth, scopes, encryption, audit log, and the
  BullMQ producer/worker split are all reused, not rebuilt.

---

## 6. Dependency direction (target — unchanged from today, just sub-foldered)

```
platform (M2M auth/scopes, outbound webhooks, settings)   [no domain, no integration deps]
   ▲
   │
integration (thin M2M controllers: read, write, inbound-webhook)
   │  └─uses─► integration-platform/write (shared pipeline)
   ▼
integration-platform  (connections, mappings, write, idempotency, imports, sync, conflicts, providers, webhooks)
   │
   ▼
crm / services / staff / appointment / scheduling  (domain business rules + persistence)
```

Rules enforced going forward:
- `platform` must never import `integration` or `integration-platform`.
- domain modules must never import any integration module.
- all writes (API, import worker, inbound webhook, sync) go through `integration-platform/write`.

---

## 7. Migration plan (structure only — additive, no behavior change)

1. Create the sub-domain folders under `integration-platform/`.
2. `git mv` existing files into `connections/ mappings/ write/ idempotency/ imports/`; fix import
   paths (single module, compiler-checked; controllers keep their `@Controller` paths).
3. Update `integration-platform.module.ts` import paths only (providers/exports list unchanged).
4. Build + typecheck to confirm zero behavior change before any feature work.
5. Land Phase 4 features into the new folders (`imports/`, `sync/`, `conflicts/`, `providers/`,
   `webhooks/`), each additive with its own migration.

## 8. Files that move vs. remain

**Move (into `integration-platform/` sub-folders):** `integration-connection.{service,controller}.ts`
+ dtos → `connections/`; `integration-id-map.service.ts` + mappings controller → `mappings/`;
`integration-upsert.service.ts`, `integration-write.service.ts`, `source-of-truth.ts` → `write/`;
`integration-idempotency.service.ts` → `idempotency/`; `integration-import.service.ts` +
`integration-data.controller.ts` (import half) → `imports/`.

**Remain in place:** everything in `modules/platform` (incl. `integration-scopes.constants.ts`);
everything in `modules/integration` (all controllers + `integration.mappers.ts`); the
`entities/Integration/*` entities; the existing migration.

## 9. Risk of breaking public APIs

**Low.** Public contracts are the `@Controller` route strings, which do not change:
- M2M (API-key): `/api/v1/integrations/*` — read + `customers/upsert`, `services/upsert`.
- Tenant (JWT): `/platform/integrations/{connections,mappings,imports}`.
Internal reorganization changes import paths only; the compiler catches any miss. No route,
DTO, permission, scope, or response shape changes. New Phase 4 routes are purely additive.

---

## 10. Consequences

- **Positive:** clear ownership, room to grow, enforced single mutation path, minimal churn now,
  no dependency inversion, public APIs preserved.
- **Negative / accepted:** the three-similar-names confusion (P1) persists unless the optional
  rename is later taken; a one-time file-move diff that is noisy but behavior-neutral.
- **Follow-ups tracked for Phase 4:** P4 (soft-delete-only guarantee for history; reconsider FK
  `ON DELETE`), P5 (scope idempotency keys to `(tenant, connection, key)` + route binding).
