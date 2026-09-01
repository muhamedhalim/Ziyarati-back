import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  ACTIVITY_VISIBLE_AUDIT_ACTIONS,
  isActivityVisible,
} from './activity-allowlist';
import { changedFields } from './activity-redaction';
import { QueryActivityLogDto } from './dto/query-activity-log.dto';
import { QueryActivitySuggestionsDto } from './dto/query-activity-suggestions.dto';
import {
  ACTIVITY_SEARCH_MIN_LENGTH,
  ACTIVITY_SUGGESTION_LIMIT,
  ACTIVITY_SUGGESTION_SCAN_LIMIT,
} from './activity-log.constants';
import type { BranchScope } from '../../core/branch-scope/branch-scope.service';

/**
 * Spec 014 (Clinic Platform Completion) — T191 (US14, F14). The clinic-facing
 * projection over `audit_logs` (S7).
 *
 * Follows `SupportActivityService`'s shape almost exactly — same allow-list
 * mechanism (`ACTIVITY_VISIBLE_AUDIT_ACTIONS`/`isActivityVisible`, T023),
 * same `changedFields` (field NAMES only, `activity-redaction.ts`, T023),
 * same tenant + pagination bounding — with two deliberate divergences:
 *
 *  1. Clinic staff are shown BY NAME (`SupportActivityService` masks them —
 *     Support is diagnosing a system, not auditing people; an OWNER must see
 *     their own staff, so this view never masks).
 *  2. The response carries `actor.id` (needed for an `actorUserId` filter
 *     round-trip) and an explicit `isSystem` flag for the no-actor case.
 *
 * SECURITY (FR-U008): `old_values`/`new_values` are read from the database
 * ONLY to compute `changedFields` and are never attached to anything this
 * service returns — there is no code path here that puts either object, or
 * any of its values, on the response.
 *
 * SECURITY (FR-U007): the allow-list is enforced TWICE — once in the SQL
 * (`al.action = ANY($n)`, so Postgres itself never returns an unlisted row),
 * and again as an in-memory filter over whatever rows do come back
 * (`isActivityVisible`). The second layer is defence in depth: an unlisted
 * action must never surface even if the SQL filter were ever bypassed by a
 * future bug. The SAME allow-list bounds the suggestions query, so a
 * typeahead can never reveal the existence of an action the list itself
 * would hide.
 *
 * SECURITY (FR-U010): every row is bound to `al."tenantId" = $1` with a
 * concrete tenant id — a NULL-tenant (platform-level) row can never match a
 * `= $1` predicate, and neither can another tenant's row, so both are
 * excluded structurally, not by an extra check. Suggestions are derived from
 * that same bounded row set and therefore inherit the isolation exactly: a
 * name only appears in a suggestion because it already appears in a row this
 * tenant is entitled to read.
 *
 * `entity_id` is stored but never dereferenced against the entity it names —
 * a row referencing a since-deleted record renders exactly like any other,
 * with no join to fail. `entity_label` exists precisely so the UI has a
 * readable name WITHOUT that dereference.
 *
 * DELETED ACTORS: `al."userId"` is selected in its own right, separately
 * from the joined `users` row. A hard-deleted user leaves the first set and
 * the second NULL — which is a "deleted actor", NOT a system action, and the
 * two must never be conflated (before this distinction existed, every
 * deleted user's actions silently re-attributed themselves to "System").
 *
 * Creates no second audit-recording mechanism — this is a READ-ONLY
 * projection over the existing `audit_logs` table. The one writer
 * (`ActivityAuditService`) lives beside it in this same module.
 */
@Injectable()
export class ActivityLogService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The joined projection every read shares. `LEFT JOIN` on both sides so a
   * missing actor (system action, or a hard-deleted user) never drops the
   * audit row itself — history must survive its actors.
   *
   * The role is resolved by a `LATERAL` subquery limited to one row rather
   * than a plain join: a user may hold several roles, and a plain join would
   * multiply the audit row by that count, silently inflating both the page
   * and `total`. It is the actor's role AS IT IS NOW, not as it was at the
   * time — the honest cheap answer; snapshotting the role per audit row
   * would mean a new column written on every single audited action.
   */
  private static readonly FROM_AND_FILTER_JOINS = `
      FROM audit_logs al
      LEFT JOIN users u ON u.id = al."userId"
      LEFT JOIN branches b ON b.id = al."branchId"`;

  /** The page's projection additionally resolves the actor's role. The COUNT
   *  query deliberately omits this join: no filter predicate touches the
   *  role, so counting through it would be pure waste on every request. */
  private static readonly ROLE_JOIN = `
      LEFT JOIN LATERAL (
        SELECT r.slug, r.name
          FROM user_roles ur
          JOIN roles r ON r.id = ur."roleId"
         WHERE ur."userId" = u.id
         ORDER BY r.is_system DESC, r.name ASC
         LIMIT 1
      ) role ON TRUE`;

  async list(
    tenantId: string,
    query: QueryActivityLogDto,
    scope: BranchScope = { branchIds: null },
  ) {
    const conditions = [`al."tenantId" = $1`, `al.action = ANY($2)`];
    const params: unknown[] = [tenantId, [...ACTIVITY_VISIBLE_AUDIT_ACTIONS]];

    if (query.actorUserId) {
      params.push(query.actorUserId);
      conditions.push(`al."userId" = $${params.length}`);
    }
    if (query.action) {
      params.push(query.action);
      conditions.push(`al.action = $${params.length}`);
    }
    // The caller's branch AUTHORIZATION. Applied whether or not a branch was
    // requested — `query.branchId` (below) can only narrow further, never
    // widen, because the controller has already refused a requested branch
    // outside this scope.
    //
    // NOTE the deliberate absence of an `OR al."branchId" IS NULL` escape:
    // `audit_logs.branchId` is nullable (a role change or a campaign launch
    // has no branch), and those un-branched rows are CLINIC-level events. A
    // branch-restricted caller must not see them, so they fall outside the
    // filter — which is the correct, conservative answer, not an oversight.
    this.applyBranchScope(scope, conditions, params);
    if (query.branchId) {
      params.push(query.branchId);
      conditions.push(`al."branchId" = $${params.length}`);
    }
    if (query.entityType) {
      params.push(query.entityType);
      conditions.push(`al.entity_type = $${params.length}`);
    }
    // Both bounds compare `created_at` directly — never wrapped in a
    // function or a cast — so the `("tenantId", "created_at" DESC)` index
    // stays usable for the range.
    if (query.from) {
      params.push(new Date(query.from));
      conditions.push(`al.created_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(new Date(query.to));
      conditions.push(`al.created_at <= $${params.length}`);
    }

    const term = searchTerm(query.q);
    if (term) {
      params.push(`%${term}%`);
      conditions.push(searchPredicate(`$${params.length}`));
    }

    const where = conditions.join(' AND ');
    const joins = ActivityLogService.FROM_AND_FILTER_JOINS;

    const [[countRow], rows] = await Promise.all([
      // The count runs over the IDENTICAL FROM/JOIN/WHERE as the page (minus
      // the projection-only role join, which no predicate touches). It used
      // to join nothing at all, which was correct only while `q` searched
      // `action` alone — the moment the search could match a joined column, a
      // differently-shaped count would have disagreed with its own page.
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total ${joins} WHERE ${where}`,
        params,
      ),
      this.dataSource.query(
        `
        SELECT al.id, al.action, al.entity_type, al.entity_id, al.entity_label,
               al.created_at, al.old_values, al.new_values,
               al."userId" AS actor_user_id,
               u.id AS actor_id, u.full_name AS actor_name, u.email AS actor_email,
               (u."tenantId" IS NULL) AS actor_is_platform,
               role.slug AS actor_role_slug, role.name AS actor_role_name,
               al."branchId" AS branch_id, b.name AS branch_name
        ${joins}${ActivityLogService.ROLE_JOIN}
         WHERE ${where}
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, query.limit, query.offset()],
      ),
    ]);

    const visible = (rows as AuditRow[]).filter((r) =>
      isActivityVisible(r.action),
    );

    return {
      data: visible.map((r) => ({
        id: r.id,
        at:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : r.created_at,
        action: r.action,
        actor: r.actor_user_id
          ? {
              id: r.actor_user_id,
              // Clinic staff shown BY NAME — the deliberate divergence from
              // SupportActivityService's masking (see the class docblock).
              // All three are null for a hard-deleted user; `isDeleted` is
              // what tells the UI to say so rather than invent a name.
              name: r.actor_name,
              email: r.actor_email,
              role: r.actor_role_slug
                ? { slug: r.actor_role_slug, name: r.actor_role_name }
                : null,
              isDeleted: !r.actor_id,
            }
          : null,
        isSystem: !r.actor_user_id,
        isPlatformActor: !!r.actor_is_platform,
        entityType: r.entity_type,
        entityId: r.entity_id ?? null,
        entityLabel: r.entity_label ?? null,
        branch: r.branch_id ? { id: r.branch_id, name: r.branch_name } : null,
        /** Key names only — never the before/after VALUES (FR-U008). */
        changedFields: changedFields(r.old_values, r.new_values),
      })),
      total: countRow?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Typeahead suggestions for the Activity search box (`GET
   * /activity/suggestions`).
   *
   * A separate, deliberately tiny endpoint rather than an option on `list`:
   * a suggestion is one short string, and returning a page of full audit
   * rows just to harvest names from it would move orders of magnitude more
   * data for a keystroke.
   *
   * SHAPE: three `UNION ALL` branches — actor names, actor emails, and
   * actions — each already bounded to this tenant's allow-listed rows, each
   * individually capped by `ACTIVITY_SUGGESTION_SCAN_LIMIT` so the work is
   * bounded no matter how much history a tenant has, then de-duplicated and
   * ranked together.
   *
   * RANKING (`rank` ascending, then `similarity` descending):
   *   0 — exact match (case-insensitive)
   *   1 — prefix match
   *   2 — everything else that contains the term
   * `similarity()` (pg_trgm) breaks ties WITHIN a tier, which is what puts
   * "Ahmed Mohamed" above "Mohamed Ahmed" for the term "Ahmed": both merely
   * contain it, but the first has it at the front and so scores higher.
   * When pg_trgm is unavailable the three tiers still order correctly and
   * ties fall back to alphabetical — never an error.
   */
  /**
   * Appends the caller's branch narrowing to a positional-parameter query.
   * A tenant-wide scope adds nothing at all, so the SQL a tenant-wide caller
   * runs is byte-identical to what it was before branch scoping existed.
   */
  private applyBranchScope(
    scope: BranchScope,
    conditions: string[],
    params: unknown[],
  ): void {
    if (scope.branchIds === null) return;
    params.push(scope.branchIds);
    // `= ANY('{}')` matches nothing — a restricted caller assigned to no
    // branch sees an empty log, never the clinic's.
    conditions.push(`al."branchId" = ANY($${params.length}::uuid[])`);
  }

  async suggestions(
    tenantId: string,
    query: QueryActivitySuggestionsDto,
    scope: BranchScope = { branchIds: null },
  ) {
    const term = searchTerm(query.q);
    if (!term) return { data: [] };
    // The RAW term drives the equality tier and `similarity()`; the ESCAPED
    // one drives every LIKE pattern. Using one for both would either let `%`
    // back into a pattern or make an exact match fail on an escaped term.
    const raw = query.q!.trim();

    const hasTrgm = await this.trigramAvailable();
    const params: unknown[] = [
      tenantId,
      [...ACTIVITY_VISIBLE_AUDIT_ACTIONS],
      `%${term}%`,
      raw,
      ACTIVITY_SUGGESTION_SCAN_LIMIT,
      Math.min(query.limit, ACTIVITY_SUGGESTION_LIMIT),
      `${term}%`,
      // $8 — the caller's branch scope, or NULL for tenant-wide. Passed as a
      // single parameter and tested with `$8 IS NULL OR …` in all four UNION
      // arms rather than conditionally splicing SQL: the arms share one
      // positional numbering, so a conditional predicate would have to
      // renumber every parameter after it.
      scope.branchIds,
    ];
    // Ranked within a tier by trigram similarity where the extension exists;
    // a constant elsewhere, which leaves the ORDER BY well-defined and lets
    // the alphabetical tiebreak decide.
    const score = hasTrgm ? `similarity(value, $4::text)` : `0::real`;

    const rows: SuggestionRow[] = await this.dataSource.query(
      `
      WITH candidates AS (
        (SELECT DISTINCT u.full_name AS value, 'actor' AS kind
           FROM audit_logs al
           JOIN users u ON u.id = al."userId"
          WHERE al."tenantId" = $1 AND al.action = ANY($2)
            AND ($8::uuid[] IS NULL OR al."branchId" = ANY($8::uuid[]))
            AND u.full_name ILIKE $3
          LIMIT $5)
        UNION ALL
        (SELECT DISTINCT u.email AS value, 'actor' AS kind
           FROM audit_logs al
           JOIN users u ON u.id = al."userId"
          WHERE al."tenantId" = $1 AND al.action = ANY($2)
            AND ($8::uuid[] IS NULL OR al."branchId" = ANY($8::uuid[]))
            AND u.email ILIKE $3
          LIMIT $5)
        UNION ALL
        (SELECT DISTINCT al.action AS value, 'action' AS kind
           FROM audit_logs al
          WHERE al."tenantId" = $1 AND al.action = ANY($2)
            AND ($8::uuid[] IS NULL OR al."branchId" = ANY($8::uuid[]))
            AND al.action ILIKE $3
          LIMIT $5)
        UNION ALL
        (SELECT DISTINCT al.entity_label AS value, 'entity' AS kind
           FROM audit_logs al
          WHERE al."tenantId" = $1 AND al.action = ANY($2)
            AND ($8::uuid[] IS NULL OR al."branchId" = ANY($8::uuid[]))
            AND al.entity_label ILIKE $3
          LIMIT $5)
      ),
      ranked AS (
        SELECT value, MIN(kind) AS kind,
               CASE
                 WHEN lower(value) = lower($4::text) THEN 0
                 WHEN value ILIKE $7                 THEN 1
                 ELSE 2
               END AS rank,
               ${score} AS score
          FROM candidates
         WHERE value IS NOT NULL AND value <> ''
         GROUP BY value, rank, score
      )
      SELECT value, kind, rank
        FROM ranked
       ORDER BY rank ASC, score DESC, value ASC
       LIMIT $6
      `,
      params,
    );

    return {
      data: rows.map((r) => ({ value: r.value, kind: r.kind })),
    };
  }

  /** The allow-list itself, for populating the filter control (`GET /activity/actions`). */
  actions(): string[] {
    return [...ACTIVITY_VISIBLE_AUDIT_ACTIONS];
  }

  /**
   * Whether `pg_trgm` is installed, resolved once per process. The migration
   * that installs it skips cleanly on a server that does not offer it, so
   * this must be a runtime question rather than an assumption — and it is
   * asked once, not per keystroke.
   */
  private trgm?: Promise<boolean>;
  private trigramAvailable(): Promise<boolean> {
    this.trgm ??= this.dataSource
      .query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`)
      .then((rows: unknown[]) => rows.length > 0)
      .catch(() => false);
    return this.trgm;
  }
}

/**
 * The columns free-text search matches, as one parenthesised predicate.
 * Each is a plain `ILIKE '%…%'`, which is exactly what the `gin_trgm_ops`
 * indexes from `1730085000000-AuditLogTrigramSearch` accelerate — so the
 * predicate needs no rewrite to use them, and stays CORRECT (merely slower)
 * anywhere the extension is absent.
 *
 * `entity_type` is included even though it has no trigram index: it holds a
 * dozen short constants, so the planner filters it in memory over the
 * already-narrowed row set rather than benefiting from one (see the
 * migration's per-column rationale). `entity_id` is matched as text so an
 * operator holding a UUID from elsewhere can paste it in and find the row.
 */
function searchPredicate(placeholder: string): string {
  return (
    `(al.action ILIKE ${placeholder}` +
    ` OR al.entity_type ILIKE ${placeholder}` +
    ` OR al.entity_label ILIKE ${placeholder}` +
    ` OR u.full_name ILIKE ${placeholder}` +
    ` OR u.email ILIKE ${placeholder}` +
    ` OR b.name ILIKE ${placeholder}` +
    ` OR al.entity_id::text ILIKE ${placeholder})`
  );
}

/**
 * Normalises a raw `q` into the term that actually reaches SQL, or
 * `undefined` for "not a search".
 *
 * Escapes `LIKE`'s three metacharacters. Without this, typing `%` matched
 * every row and `_` matched any character — user input silently altering the
 * SQL's meaning. The backslash is Postgres's default LIKE escape character,
 * so `\\` must be escaped first or it would go on to escape the very
 * characters this function just added.
 *
 * Trailing/leading whitespace is dropped, and anything shorter than
 * `ACTIVITY_SEARCH_MIN_LENGTH` is treated as no search at all — a one-
 * character pattern matches a large fraction of any history and is below the
 * width a trigram index can be selective on. Unicode is untouched, so Arabic
 * terms work exactly like Latin ones: `ILIKE` is case-insensitive per the
 * database's collation, and Arabic has no case to fold.
 */
function searchTerm(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length < ACTIVITY_SEARCH_MIN_LENGTH) return undefined;
  return trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

interface AuditRow {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  created_at: Date;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  /** From `audit_logs` itself — set even when the user row is gone. */
  actor_user_id: string | null;
  /** From the joined `users` row — NULL when that user was hard-deleted. */
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_is_platform: boolean | null;
  actor_role_slug: string | null;
  actor_role_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
}

interface SuggestionRow {
  value: string;
  kind: 'actor' | 'action' | 'entity';
  rank: number;
}
