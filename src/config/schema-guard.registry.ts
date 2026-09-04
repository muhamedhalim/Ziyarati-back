import { Injectable, Logger } from '@nestjs/common';

/**
 * How much it matters that a bootstrap statement succeeded.
 *
 * `required` — a DB-enforced integrity guard. Its absence changes what
 *   PostgreSQL will ACCEPT: a duplicate charge, a replayed webhook, two
 *   accounts on one email, a second invoice for one period. The application
 *   cannot substitute for it, because the races these guards close are
 *   precisely the ones no read-then-write check can see (READ COMMITTED has
 *   no gap locks). A `required` failure is an ERROR and degrades readiness.
 *
 * `optional` — a performance index or an enhancement. Losing one costs
 *   latency, never correctness. Stays a warning, exactly as before.
 *
 * P0.2 proved this distinction was the missing one: every bootstrap used a
 * single fail-soft policy, so `uq_refund_idem` failing to install and a
 * dashboard index failing to install produced the identical one-line `warn`.
 */
export type SchemaGuardCriticality = 'required' | 'optional';

export interface SchemaGuardOutcome {
  /** Human label, as passed by the bootstrap. */
  label: string;
  /** Which bootstrap issued it — so an operator knows where to look. */
  owner: string;
  criticality: SchemaGuardCriticality;
  status: 'ok' | 'failed' | 'blocked';
  /** Postgres's own message. Never rendered to a public client. */
  detail?: string;
}

/**
 * Collects the outcome of every `OnApplicationBootstrap` schema statement so
 * a missing integrity guard is (a) an ERROR in the log, (b) visible on the
 * readiness probe, and (c) queryable as one structured object rather than
 * grepped out of scrollback.
 *
 * WHY IT DOES NOT THROW. Making a bootstrap fatal turns "one index is
 * missing" into "the clinic cannot take bookings" — strictly worse for a
 * live tenant, and it would also make the SELF-LOCKING case (below) an
 * unrecoverable crash loop. P0.3 therefore separates *noticing* from
 * *stopping*: this class guarantees the failure is impossible to miss, and
 * `SCHEMA_GUARD_FAIL_READINESS=true` lets an operator whose orchestrator
 * routes on readiness choose fail-closed traffic behaviour on top.
 *
 * THE SELF-LOCKING CASE this exists for, observed on a real database (P0.3
 * FIX-001): `CREATE UNIQUE INDEX IF NOT EXISTS` FAILS when the table already
 * contains duplicates. So "guard missing → duplicates accumulate → the
 * bootstrap can never succeed again" is a one-way door, and under the old
 * policy it announced itself as a single `warn` line on every boot forever.
 */
@Injectable()
export class SchemaGuardRegistry {
  private readonly logger = new Logger('SchemaGuard');
  private readonly outcomes = new Map<string, SchemaGuardOutcome>();

  /**
   * Executes one DDL statement and records what happened.
   *
   * Returns `true` on success so a caller can make a follow-up statement
   * conditional (e.g. skip an index whose table failed to create).
   */
  async ensure(opts: {
    owner: string;
    label: string;
    criticality: SchemaGuardCriticality;
    run: () => Promise<unknown>;
  }): Promise<boolean> {
    const key = `${opts.owner}::${opts.label}`;
    try {
      await opts.run();
      this.outcomes.set(key, {
        label: opts.label,
        owner: opts.owner,
        criticality: opts.criticality,
        status: 'ok',
      });
      return true;
    } catch (err) {
      const detail = (err as Error).message;
      this.outcomes.set(key, {
        label: opts.label,
        owner: opts.owner,
        criticality: opts.criticality,
        status: 'failed',
        detail,
      });
      if (opts.criticality === 'required') {
        this.logger.error(
          `INTEGRITY GUARD NOT INSTALLED — "${opts.label}" (${opts.owner}): ${detail}. ` +
            `PostgreSQL is NOT enforcing this rule. Run ` +
            `\`psql "$DATABASE_URL" -f tests/load/reports/P0.3_PRODUCTION_VERIFICATION.sql\` ` +
            `for the full picture; if the cause is pre-existing duplicate rows the guard ` +
            `CANNOT be installed until they are resolved by a deliberate decision.`,
        );
      } else {
        this.logger.warn(`Skipped "${opts.label}" (${opts.owner}): ${detail}`);
      }
      return false;
    }
  }

  /**
   * Records a guard that was NOT attempted because conflicting rows already
   * exist. Distinct from `failed` on purpose: `blocked` means the database
   * holds data that violates the intended rule, so installing the guard needs
   * a data decision, not a retry.
   *
   * P0.3 RULE 9: nothing here deletes, merges or rewrites the conflicting
   * rows. It reports them and stops.
   */
  reportBlocked(opts: {
    owner: string;
    label: string;
    criticality: SchemaGuardCriticality;
    conflicts: number;
    detail: string;
  }): void {
    this.outcomes.set(`${opts.owner}::${opts.label}`, {
      label: opts.label,
      owner: opts.owner,
      criticality: opts.criticality,
      status: 'blocked',
      detail: opts.detail,
    });
    const line =
      `INTEGRITY GUARD BLOCKED BY EXISTING DATA — "${opts.label}" (${opts.owner}): ` +
      `${opts.conflicts} conflicting row(s). ${opts.detail} ` +
      `No rows were changed. Resolving this is a business decision, not an automatic repair ` +
      `— see tests/load/reports/P0.3_REPAIR_RUNBOOK.md.`;
    if (opts.criticality === 'required') this.logger.error(line);
    else this.logger.warn(line);
  }

  /** Every `required` guard that is not installed. */
  failures(): SchemaGuardOutcome[] {
    return [...this.outcomes.values()].filter(
      (o) => o.criticality === 'required' && o.status !== 'ok',
    );
  }

  /**
   * Public-safe summary for the readiness probe: counts only.
   *
   * Deliberately carries NO object name, table name or Postgres message —
   * `system/health/readiness` is unauthenticated, and naming a missing
   * uniqueness guard there would tell an anonymous caller exactly which
   * duplicate to attempt. The detail lives in the log and in
   * {@link failures}, both of which require operator access.
   */
  summary(): {
    status: 'ok' | 'degraded';
    requiredChecked: number;
    requiredFailed: number;
  } {
    const required = [...this.outcomes.values()].filter(
      (o) => o.criticality === 'required',
    );
    const failed = required.filter((o) => o.status !== 'ok').length;
    return {
      status: failed === 0 ? 'ok' : 'degraded',
      requiredChecked: required.length,
      requiredFailed: failed,
    };
  }
}
