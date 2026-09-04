import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform model policy: only GPT-5.6 Luna and GPT-5.6 Terra are permitted.
 *
 * `AI_MODEL_REGISTRY` now contains only `gpt-5.6-luna` and `gpt-5.6-terra`, so
 * every WRITE path (the agent DTO's `IsIn`, the `ai.default_model` enum
 * validator, the model env vars' Joi `.valid()`) already refuses anything else.
 * This migration deals with what was written BEFORE that policy existed:
 *
 *  1. `ai_agents.model` — a free `varchar(100)` a clinic admin could once type
 *     into. With model routing off (the shipped state) this column IS the model
 *     a turn runs on, so a stale `gpt-4o` here would have kept executing.
 *  2. `system_settings` row `ai.default_model` — its registry default moved from
 *     `gpt-4o` to `gpt-5.6-terra`, but a row already in the table overrides the
 *     default and would have kept a now-invalid value that the UI could no
 *     longer even re-select.
 *
 * MAPPING — tier-preserving, matching `AI_MODEL_REGISTRY`'s own `tier` field:
 *
 *     gpt-4o      POWERFUL  ->  gpt-5.6-terra   POWERFUL
 *     gpt-4.1     STANDARD  ->  gpt-5.6-terra   (nearest by weight; no
 *                                                STANDARD model remains)
 *     gpt-4o-mini ECONOMY   ->  gpt-5.6-luna    ECONOMY
 *     gpt-4.1-mini ECONOMY  ->  gpt-5.6-luna    ECONOMY
 *     anything else / NULL  ->  gpt-5.6-luna    (see below)
 *
 * Dated snapshot aliases (`gpt-4o-2024-08-06`, `gpt-4.1-mini-2025-04-14`, …)
 * are matched by prefix, because the registry resolved them to their canonical
 * model and so did the price catalog — a row holding one is the same clinic's
 * same choice, spelled differently.
 *
 * Anything unrecognized maps to Luna rather than Terra: an unmapped string is
 * a value nobody can vouch for, and the cheaper model is the safe direction to
 * fail. `NULL` is deliberately LEFT NULL — it means "no pinned model", which is
 * still valid and now resolves to `ai.default_model` at run time. Rewriting
 * NULLs would silently pin every clinic to a model and quietly break that.
 *
 * NO DATA IS DELETED and no column is dropped. `ai_agents.model` keeps its
 * `varchar(100)` shape and gets no CHECK constraint: the allow-list is product
 * policy that moves when the model catalog moves, every writer is already
 * validated, and `AiModelRouterService` re-checks the stored value on every
 * single turn — so a row that somehow went bad still could not execute. Pinning
 * the list into DDL would buy nothing and would cost a migration per catalog
 * change (and an amendment to the frozen 43-guard P0.4 schema contract).
 */
export class AiModelPolicyLunaTerra1730091000000 implements MigrationInterface {
  public async up(q: QueryRunner): Promise<void> {
    // ── 1. Agent rows ─────────────────────────────────────────────────────
    // One statement, evaluated per row. `LOWER(TRIM(...))` mirrors
    // `findModel()`'s own case/whitespace-insensitive resolution, so a row
    // stored as ' GPT-4O ' is migrated rather than falling to the catch-all.
    await q.query(`
      UPDATE "ai_agents"
         SET "model" = CASE
               WHEN LOWER(TRIM("model")) LIKE 'gpt-4o-mini%'  THEN 'gpt-5.6-luna'
               WHEN LOWER(TRIM("model")) LIKE 'gpt-4.1-mini%' THEN 'gpt-5.6-luna'
               WHEN LOWER(TRIM("model")) LIKE 'gpt-4.1-nano%' THEN 'gpt-5.6-luna'
               WHEN LOWER(TRIM("model")) LIKE 'gpt-4o%'       THEN 'gpt-5.6-terra'
               WHEN LOWER(TRIM("model")) LIKE 'gpt-4.1%'      THEN 'gpt-5.6-terra'
               ELSE 'gpt-5.6-luna'
             END
       WHERE "model" IS NOT NULL
         AND LOWER(TRIM("model")) NOT IN ('gpt-5.6-luna', 'gpt-5.6-terra')
    `);

    // Canonicalize casing/whitespace on rows that already hold a permitted
    // model, so every surviving value is byte-identical to a registry id.
    await q.query(`
      UPDATE "ai_agents"
         SET "model" = LOWER(TRIM("model"))
       WHERE "model" IS NOT NULL
         AND LOWER(TRIM("model")) IN ('gpt-5.6-luna', 'gpt-5.6-terra')
         AND "model" <> LOWER(TRIM("model"))
    `);

    // ── 2. The platform setting ───────────────────────────────────────────
    // `system_settings.value` is jsonb, so the comparison and the write both
    // go through the ->> text projection / to_jsonb round-trip.
    await q.query(`
      UPDATE "system_settings"
         SET "value" = to_jsonb(
               CASE
                 WHEN LOWER(TRIM("value" #>> '{}')) LIKE 'gpt-4o-mini%'  THEN 'gpt-5.6-luna'
                 WHEN LOWER(TRIM("value" #>> '{}')) LIKE 'gpt-4.1-mini%' THEN 'gpt-5.6-luna'
                 WHEN LOWER(TRIM("value" #>> '{}')) LIKE 'gpt-4.1-nano%' THEN 'gpt-5.6-luna'
                 WHEN LOWER(TRIM("value" #>> '{}')) LIKE 'gpt-4o%'       THEN 'gpt-5.6-terra'
                 WHEN LOWER(TRIM("value" #>> '{}')) LIKE 'gpt-4.1%'      THEN 'gpt-5.6-terra'
                 ELSE 'gpt-5.6-terra'
               END
             )
       WHERE "key" = 'ai.default_model'
         AND LOWER(TRIM(COALESCE("value" #>> '{}', ''))) NOT IN ('gpt-5.6-luna', 'gpt-5.6-terra')
    `);
    // NOTE the ELSE here is Terra, not Luna: this key's own previous default was
    // 'gpt-4o' (POWERFUL), so an unreadable value maps to the same place the
    // registry default did. The agent-row ELSE stays Luna because a per-clinic
    // string nobody can vouch for is a different situation from the platform's
    // own documented default.
  }

  public async down(): Promise<void> {
    // Deliberately NOT reversible. The pre-migration model of each agent row is
    // not recorded, and restoring it would re-introduce values the application
    // now refuses to dispatch — a "rollback" that leaves every affected clinic
    // unable to run a turn is worse than no rollback. Reverting the POLICY is a
    // code change (re-register a model in AI_MODEL_REGISTRY), after which a
    // super admin re-selects it at /platform/system-settings.
  }
}
