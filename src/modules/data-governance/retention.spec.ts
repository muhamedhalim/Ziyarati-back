import { ConfigService } from '@nestjs/config';

import { classifyTable } from './data-classification';
import {
  NEVER_AUTO_PURGED,
  RETENTION_TARGETS,
  resolveRetentionPolicy,
  settingFor,
} from './retention-policy';
import {
  PLATFORM_TENANT_ID,
  RETENTION_BATCH_SIZE,
  RetentionService,
} from './retention.service';
import { loadEntityMetadata } from './entity-metadata.test-util';
import { validate } from '../../config/env.validation';

/**
 * Residency plan P12 — the retention MECHANISM, with no built-in values. The
 * statements themselves run against PostgreSQL in
 * test/integration/retention.int-spec.ts.
 */
describe('retention policy', () => {
  it('has NO default: every target is inert until its setting is given', () => {
    for (const e of resolveRetentionPolicy(() => undefined))
      expect(e.days).toBeNull();
  });

  it('reads only positive whole numbers; anything else leaves the target inert', () => {
    const only = (v: string | number | undefined) =>
      resolveRetentionPolicy((k) =>
        k === settingFor(RETENTION_TARGETS[0]) ? v : undefined,
      )[0].days;
    expect(only('30')).toBe(30);
    expect(only(90)).toBe(90);
    for (const bad of ['0', '-5', '1.5', 'abc', '', '  ', undefined])
      expect(only(bad)).toBeNull();
  });

  it('derives each setting name from the target id', () => {
    expect(RETENTION_TARGETS.map(settingFor)).toEqual([
      'RETENTION_EMAIL_LOGS_DAYS',
      'RETENTION_WHATSAPP_WEBHOOKS_DAYS',
      'RETENTION_SCHEDULED_NOTIFICATION_VARIABLES_DAYS',
      'RETENTION_AI_TRANSCRIPTS_DAYS',
    ]);
  });

  it('accepts every setting in the environment schema, and rejects a non-integer', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      JWT_ACCESS_SECRET: 'secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      REDIS_URL: 'redis://localhost:6379',
    };
    for (const t of RETENTION_TARGETS) {
      expect(validate({ ...base, [settingFor(t)]: '30' })[settingFor(t)]).toBe(
        30,
      );
      expect(() => validate({ ...base, [settingFor(t)]: 'abc' })).toThrow(
        settingFor(t),
      );
      expect(() => validate({ ...base, [settingFor(t)]: '0' })).toThrow(
        settingFor(t),
      );
      // And nothing is defaulted in.
      expect(
        (validate(base) as Record<string, unknown>)[settingFor(t)],
      ).toBeUndefined();
    }
  });

  describe('what it may touch', () => {
    it('targets only tables that exist, with the columns it filters on', async () => {
      const metas = new Map(
        (await loadEntityMetadata()).map((m) => [m.tableName, m]),
      );
      for (const t of RETENTION_TARGETS) {
        const meta = metas.get(t.table);
        expect(meta ? t.table : `missing table ${t.table}`).toBe(t.table);
        const cols = new Set(meta!.columns.map((c) => c.databaseName));
        expect(cols.has(t.timestampColumn)).toBe(true);
        for (const m of `${t.eligible ?? ''} ${t.set ?? ''}`.matchAll(
          /"([A-Za-z_]+)"/g,
        )) {
          expect(
            cols.has(m[1])
              ? true
              : `${t.id}: ${t.table}.${m[1]} does not exist`,
          ).toBe(true);
        }
      }
    });

    it('NEVER targets clinical, identity, payment or audit data', () => {
      const FORBIDDEN = new Set(['D3', 'D5', 'D7']);
      for (const t of RETENTION_TARGETS) {
        const classes = classifyTable(t.table)?.classes ?? [];
        expect(
          classes.some((c) => FORBIDDEN.has(c))
            ? `${t.table} holds a protected class`
            : 'ok',
        ).toBe('ok');
      }
      const PROTECTED = [
        'customers',
        'customer_profiles',
        'customer_notes',
        'customer_files',
        'appointments',
        'clinical_entries',
        'clinical_encounters',
        'invoices',
        'payments',
        'refunds',
        'transactions',
        'audit_logs',
        'clinical_access_logs',
        'data_subject_requests',
        'deletion_evidence',
      ];
      expect(
        RETENTION_TARGETS.filter((t) => PROTECTED.includes(t.table)).map(
          (t) => t.table,
        ),
      ).toEqual([]);
    });

    it('records what it never purges, and why', () => {
      expect(NEVER_AUTO_PURGED.map((n) => n.scope).join(' ')).toMatch(
        /clinical/,
      );
      expect(NEVER_AUTO_PURGED.every((n) => n.reason.length > 20)).toBe(true);
    });

    it('gives every scrub target a SET clause and no delete target one', () => {
      for (const t of RETENTION_TARGETS)
        expect(!!t.set).toBe(t.action === 'scrub');
    });

    it('never hard-codes a tenant-less delete without an age filter', () => {
      // Every statement is built from the timestamp column; there is no target
      // whose predicate could match a row regardless of age.
      for (const t of RETENTION_TARGETS) expect(t.timestampColumn).toBeTruthy();
    });
  });
});

describe('RetentionService', () => {
  const NOW = new Date('2026-10-06T00:00:00.000Z');

  function build(
    settings: Record<string, string>,
    affectedPerCall: number[] = [],
  ) {
    const saved: unknown[] = [];
    // Counts go through the DataSource; batched mutations through a query runner.
    const query = jest.fn(
      async (text: string, _p?: unknown[], structured?: boolean) => {
        if (/^SELECT count/.test(text)) return [{ n: 7 }];
        if (structured)
          return {
            affected: affectedPerCall.length ? affectedPerCall.shift() : 0,
          };
        return [];
      },
    );
    const runner = { connect: jest.fn(), release: jest.fn(), query };
    const repo = {
      create: (v: unknown) => v,
      save: jest.fn(async (v: Record<string, unknown>) => {
        saved.push(v);
        return { ...v, id: 'ev-1' };
      }),
    };
    const ds = {
      query,
      getRepository: () => repo,
      createQueryRunner: () => runner,
    };
    const svc = new RetentionService(ds as never, new ConfigService(settings));
    return { svc, query, saved, repo };
  }

  it('with nothing configured selects nothing and writes no evidence — even for a real run', async () => {
    const { svc, query, repo } = build({});
    const r = await svc.run({ dryRun: false, now: NOW });
    expect(
      r.targets.every((t) => t.skipped === 'no_setting' && t.affected === 0),
    ).toBe(true);
    expect(query).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(r.evidenceId).toBeUndefined();
  });

  it('a dry run counts, changes nothing and writes no evidence', async () => {
    const { svc, query, repo } = build({ RETENTION_EMAIL_LOGS_DAYS: '30' });
    const r = await svc.run({ dryRun: true, now: NOW });
    const email = r.targets.find((t) => t.id === 'EMAIL_LOGS')!;
    expect(email).toMatchObject({
      days: 30,
      affected: 7,
      cutoff: '2026-09-06T00:00:00.000Z',
    });
    expect(
      query.mock.calls.every((c) => /^SELECT count/.test(String(c[0]))),
    ).toBe(true);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('a real run deletes in batches until a short batch, and records platform-scoped evidence', async () => {
    const { svc, query, saved } = build({ RETENTION_EMAIL_LOGS_DAYS: '30' }, [
      RETENTION_BATCH_SIZE,
      RETENTION_BATCH_SIZE,
      12,
    ]);
    const r = await svc.run({ dryRun: false, now: NOW });

    expect(r.targets.find((t) => t.id === 'EMAIL_LOGS')?.affected).toBe(
      RETENTION_BATCH_SIZE * 2 + 12,
    );
    expect(query).toHaveBeenCalledTimes(3);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(
      /^DELETE FROM "email_logs" WHERE ctid IN \(SELECT ctid FROM "email_logs" WHERE "created_at" < \$1 LIMIT 5000\)/,
    );
    expect(query.mock.calls[0][1]).toEqual([
      new Date('2026-09-06T00:00:00.000Z'),
    ]);

    expect(r.evidenceId).toBe('ev-1');
    expect(saved[0]).toMatchObject({
      scope: 'RETENTION',
      tenant_id: PLATFORM_TENANT_ID,
      subject_id: null,
      status: 'COMPLETED',
    });
    const stores = (
      saved[0] as { report: { stores: Array<Record<string, unknown>> } }
    ).report.stores;
    expect(stores).toEqual([
      expect.objectContaining({
        target: 'email_logs',
        action: 'deleted',
        affected: RETENTION_BATCH_SIZE * 2 + 12,
      }),
    ]);
    // Evidence names tables and counts — never a row value.
    expect(JSON.stringify(saved[0])).not.toMatch(/@|\+966/);
  });

  it('scrub targets issue an UPDATE restricted to eligible rows', async () => {
    const { svc, query } = build(
      { RETENTION_SCHEDULED_NOTIFICATION_VARIABLES_DAYS: '14' },
      [3],
    );
    await svc.run({ dryRun: false, now: NOW });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(
      /^UPDATE "scheduled_notifications" SET "variables" = '\{\}'::jsonb/,
    );
    expect(sql).toContain(
      `"status" IN ('SENT', 'DELIVERED', 'FAILED', 'CANCELLED', 'SEND_UNCERTAIN')`,
    );
  });

  it('only processed webhook payloads are eligible', async () => {
    const { svc, query } = build(
      { RETENTION_WHATSAPP_WEBHOOKS_DAYS: '7' },
      [1],
    );
    await svc.run({ dryRun: false, now: NOW });
    expect(String(query.mock.calls[0][0])).toContain(`("processed" = true)`);
  });

  it('writes no evidence when a configured run removed nothing', async () => {
    const { svc, repo } = build({ RETENTION_EMAIL_LOGS_DAYS: '30' }, [0]);
    const r = await svc.run({ dryRun: false, now: NOW });
    expect(repo.save).not.toHaveBeenCalled();
    expect(r.evidenceId).toBeUndefined();
  });
});
