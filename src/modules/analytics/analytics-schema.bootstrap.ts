import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * Idempotently ensures the analytics performance + integrity schema objects:
 *
 *  - Composite indexes on the SOURCE tables the aggregation engine scans by
 *    (tenant, …, time). The frozen entities only index a subset
 *    (`appointments` already has `(tenant,branch,start_at)`), leaving the
 *    revenue / customer / AI / conversation / review scans unindexed — full
 *    table scans at millions of rows. (Audit H1.)
 *  - A UNIQUE index on `dashboard_metrics (tenantId, metric_key, period)` so the
 *    snapshot upsert is atomic and concurrent refreshes can't create duplicate
 *    rows. (Audit H2.)
 *  - Indexes on `analytics_events` for the tenant-scoped listing filter and the
 *    retention purge sweep. (Audit: retention.)
 *
 * Why a bootstrap: dev runs `synchronize=true` (the migration does NOT run
 * there). Every statement is `IF NOT EXISTS`, so it is safe on every boot in
 * every environment; `1730000400000-AnalyticsHardening.ts` mirrors these for
 * migrations-first prod. FK columns follow TypeORM's default camelCase
 * naming in this project (`"tenantId"`, `"branchId"`, `"appointmentId"`).
 *
 * FAILURE POLICY (P0.3 SCHEMA-004): `requireUnique()` for the integrity guard
 * (ERROR + degraded readiness), `run()` for the performance indexes (warning,
 * unchanged). Neither throws.
 */
@Injectable()
export class AnalyticsSchemaBootstrap implements OnApplicationBootstrap {
  private static readonly OWNER = 'AnalyticsSchemaBootstrap';

  constructor(
    private readonly dataSource: DataSource,
    private readonly guards: SchemaGuardRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // ── H1: source-table aggregation indexes ────────────────────────────────
    await this.run(
      'payments revenue index',
      `
      CREATE INDEX IF NOT EXISTS idx_payments_revenue
      ON payments ("tenantId", "branchId", status, paid_at)
    `,
    );
    await this.run(
      'customers created index',
      `
      CREATE INDEX IF NOT EXISTS idx_customers_tenant_created
      ON customers ("tenantId", created_at)
    `,
    );
    await this.run(
      'ai_messages created index',
      `
      CREATE INDEX IF NOT EXISTS idx_ai_messages_tenant_created
      ON ai_messages ("tenantId", created_at)
    `,
    );
    await this.run(
      'conversations active index',
      `
      CREATE INDEX IF NOT EXISTS idx_conversations_tenant_lastmsg
      ON conversations ("tenantId", last_message_at)
    `,
    );
    await this.run(
      'customer_reviews index',
      `
      CREATE INDEX IF NOT EXISTS idx_customer_reviews_tenant_created
      ON customer_reviews ("tenantId", created_at)
    `,
    );
    await this.run(
      'appointment_services join index',
      `
      CREATE INDEX IF NOT EXISTS idx_appointment_services_appt
      ON appointment_services ("appointmentId", "serviceId")
    `,
    );

    // ── H2: dashboard_metrics uniqueness ────────────────────────────────────
    //
    // P0.3 FIX-003: the `DELETE FROM dashboard_metrics … WHERE a.ctid < b.ctid`
    // that used to run here — unconditionally, on every boot, in every
    // environment — has been replaced by a count-and-report pre-check. See
    // `ConversationsSchemaBootstrap`'s docstring for the full rationale; in
    // short, deleting rows to make a `CREATE UNIQUE INDEX` succeed picks an
    // arbitrary survivor by physical row location and reports nothing.
    await this.requireUnique({
      label: 'dashboard_metrics unique',
      create: `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_metric
        ON dashboard_metrics ("tenantId", metric_key, period)
      `,
      // `period` is nullable and PostgreSQL treats NULLs as DISTINCT, so rows
      // with a NULL period never collide — `IS NOT DISTINCT FROM` (the old
      // DELETE's comparison) would have over-counted them as conflicts.
      conflicts: `
        SELECT coalesce(sum(n) - count(*), 0)::bigint AS excess FROM (
          SELECT count(*) AS n FROM dashboard_metrics
           WHERE "tenantId" IS NOT NULL AND metric_key IS NOT NULL AND period IS NOT NULL
           GROUP BY "tenantId", metric_key, period HAVING count(*) > 1) x
      `,
      conflictDetail:
        'Two or more rows in `dashboard_metrics` share (tenantId, metric_key, period) — ' +
        'concurrent snapshot refreshes are creating duplicate metric rows instead of ' +
        'upserting, so dashboard figures for those keys are not single-valued.',
    });

    // ── Analytics events: listing filter + retention purge ───────────────────
    await this.run(
      'analytics_events listing index',
      `
      CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_created
      ON analytics_events ("tenantId", created_at)
    `,
    );
    await this.run(
      'analytics_events retention index',
      `
      CREATE INDEX IF NOT EXISTS idx_analytics_events_created
      ON analytics_events (created_at)
    `,
    );
  }

  /**
   * Installs a uniqueness guard, or reports precisely why it cannot be
   * installed. Never deletes, merges or rewrites a row (P0.3 RULE 9).
   */
  private async requireUnique(spec: {
    label: string;
    create: string;
    conflicts: string;
    conflictDetail: string;
  }): Promise<void> {
    let excess: number | null = null;
    try {
      const rows = (await this.dataSource.query(spec.conflicts)) as Array<
        Record<string, unknown>
      >;
      excess = Number(Object.values(rows[0] ?? {})[0] ?? 0);
    } catch {
      excess = null; // table absent on a first boot — let CREATE report it
    }

    if (excess !== null && excess > 0) {
      this.guards.reportBlocked({
        owner: AnalyticsSchemaBootstrap.OWNER,
        label: spec.label,
        criticality: 'required',
        conflicts: excess,
        detail: spec.conflictDetail,
      });
      return;
    }

    await this.guards.ensure({
      owner: AnalyticsSchemaBootstrap.OWNER,
      label: spec.label,
      criticality: 'required',
      run: () => this.dataSource.query(spec.create),
    });
  }

  /** A performance index. Losing one costs latency, not correctness. */
  private async run(label: string, sql: string): Promise<void> {
    await this.guards.ensure({
      owner: AnalyticsSchemaBootstrap.OWNER,
      label,
      criticality: 'optional',
      run: () => this.dataSource.query(sql),
    });
  }
}
