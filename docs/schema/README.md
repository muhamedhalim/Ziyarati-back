# Database Schema Snapshot

`schema.sql` is an **authoritative, generated** snapshot of the physical PostgreSQL
schema, assembled from the committed TypeORM migrations (`src/migrations/*`).

## Why this file exists

This project is **migration-driven**: `synchronize` is `false` in every environment,
and `migrationsRun` provisions a fresh database deterministically from the 15
migrations. There was previously **no checked-in canonical schema file**, so the only
way to know the physical schema was to read 15 migration files plus ~95 entity classes.
That gap is what caused an earlier AI documentation pass to report a false
"`Patient` is missing from `canonical-schema.sql`" discrepancy — it was grepping a file
that does not exist. This snapshot closes that gap.

## What it contains

The `up()` DDL of every migration, concatenated **in execution order**:

1. `1700000000000-BaselineSchema` — the full entity-derived baseline (97 tables, enums,
   indexes, FKs). Generated originally by `typeorm migration:generate`.
2. The 14 incremental hardening migrations, which add **non-entity** objects that the
   entities alone do not express, including:
   - `appointments_no_overlap` — `btree_gist` EXCLUSION constraint (race-proof double-booking guard)
   - `uq_txn_webhook_event` — partial UNIQUE index for idempotent webhook processing
   - `UQ_campaign_recipients_provider_ref` / `UQ_scheduled_notifications_provider_ref` — exactly-once send guards
   - `tenant_counters`, `settlement_adjustments` — operational tables
   - `trg_transactions_immutable` — append-only ledger trigger
   - `vector` (pgvector) extension + `vector(1536)` embedding column for RAG

## Regenerating

```bash
node scripts/extract-schema.js
```

Re-run after adding or editing a migration. The script is a pure text extractor over
`queryRunner.query(`...`)` calls in each migration's `up()` half — it does **not**
connect to a database, so it is safe to run anywhere and is deterministic.

## Caveats

- This reflects the **migrations**, which are the source of truth — not a live
  database. If a database has drifted from the migrations, reconcile the database, not
  this file.
- `down()` (rollback) DDL is intentionally excluded.
- FK column names are **camelCase** (`"tenantId"`, `"staffId"`) — the default TypeORM
  naming strategy is in use (no snake-case strategy). Raw query-builder column strings
  must match this casing.
