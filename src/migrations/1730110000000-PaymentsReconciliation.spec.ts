import { PaymentsReconciliation1730110000000 as Migration } from './1730110000000-PaymentsReconciliation';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const run = async (fn: 'up' | 'down') => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration()[fn]({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

const find = (calls: string[], needle: string) =>
  calls.find((c) => c.includes(needle))!;

describe('PaymentsReconciliation migration (Tap Phase 5 / plan §17 M4)', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe('PaymentsReconciliation1730110000000');
  });

  describe('up()', () => {
    it('settlements: adds source (defaulted, so every existing batch stays INTERNAL) and three nullable provider columns', async () => {
      const alter = find(await run('up'), 'ALTER TABLE "settlements"');
      expect(alter).toContain(
        `ADD COLUMN IF NOT EXISTS "source" varchar(16) NOT NULL DEFAULT 'INTERNAL'`,
      );
      for (const col of [
        '"provider" varchar(32)',
        '"provider_payout_id" varchar(64)',
        '"bank_reference" varchar(64)',
      ]) {
        expect(alter).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      }
      expect(alter.match(/NOT NULL/g)).toHaveLength(1); // only `source`
    });

    it('settlements: a PARTIAL UNIQUE index so a payout is mirrored at most once', async () => {
      const idx = find(await run('up'), 'UQ_settlements_provider_payout');
      expect(idx).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
      expect(idx).toContain('("provider", "provider_payout_id")');
      expect(idx).toContain('WHERE "provider_payout_id" IS NOT NULL');
    });

    it('payments: one nullable column, nothing else touched', async () => {
      const alter = find(await run('up'), 'ALTER TABLE "payments"');
      expect(alter).toContain(
        'ADD COLUMN IF NOT EXISTS "provider_payout_id" varchar(64)',
      );
      expect(alter).not.toMatch(/NOT NULL/);
    });

    it('merchant_accounts: two nullable report-status columns', async () => {
      const alter = find(await run('up'), 'ALTER TABLE "merchant_accounts"');
      expect(alter).toContain('"provider_reports_status" varchar(16)');
      expect(alter).toContain('"provider_reports_checked_at" timestamptz');
      expect(alter).not.toMatch(/NOT NULL/);
    });

    it('subscription_invoices: refund bookkeeping; only the attempt counter is NOT NULL (defaulted)', async () => {
      const alter = find(
        await run('up'),
        'ALTER TABLE "subscription_invoices"',
      );
      for (const col of [
        '"refund_reference" varchar(64)',
        '"refund_requested_at" timestamptz',
        '"refunded_at" timestamptz',
        '"refund_attempts" integer NOT NULL DEFAULT 0',
        '"refund_reason" text',
      ]) {
        expect(alter).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      }
      expect(alter.match(/NOT NULL/g)).toHaveLength(1);
    });

    it('creates the exceptions table idempotently with a UNIQUE (kind, provider_object_id) so a re-run re-finds a row', async () => {
      const calls = await run('up');
      const table = find(
        calls,
        'CREATE TABLE IF NOT EXISTS "payment_reconciliation_exceptions"',
      );
      for (const col of [
        '"kind" varchar(40) NOT NULL',
        '"provider" varchar(32) NOT NULL',
        '"provider_object_id" varchar(96) NOT NULL',
        `"status" varchar(16) NOT NULL DEFAULT 'OPEN'`,
        '"details" jsonb',
        '"resolved_by" uuid',
      ]) {
        expect(table).toContain(col);
      }
      const unique = find(calls, 'UQ_recon_exception_kind_object');
      expect(unique).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
      expect(unique).toContain('("kind", "provider_object_id")');
    });

    it('is additive: no UPDATE, no DROP, no RENAME, no existing column altered', async () => {
      const sql = (await run('up')).join(' ');
      expect(sql).not.toMatch(/\bUPDATE\b|\bDROP\b|RENAME|ALTER COLUMN/i);
    });
  });

  describe('down()', () => {
    it('removes only what up() added, indexes and table first', async () => {
      const calls = await run('down');
      const sql = calls.join(' | ');
      expect(calls[0]).toContain(
        'DROP INDEX IF EXISTS "IX_recon_exception_tenant"',
      );
      expect(sql).toContain(
        'DROP TABLE IF EXISTS "payment_reconciliation_exceptions"',
      );
      expect(sql).toContain(
        'DROP INDEX IF EXISTS "UQ_settlements_provider_payout"',
      );
      for (const col of [
        'refund_reason',
        'refund_attempts',
        'refunded_at',
        'refund_requested_at',
        'refund_reference',
        'provider_reports_checked_at',
        'provider_reports_status',
        'provider_payout_id',
        'bank_reference',
        'provider',
      ]) {
        expect(sql).toContain(`DROP COLUMN IF EXISTS "${col}"`);
      }
      expect(sql).toContain('DROP COLUMN IF EXISTS "source"');
      // never a pre-existing column
      expect(sql).not.toMatch(
        /DROP COLUMN IF EXISTS "(amount|status|gateway_fee|net_amount|provider_recipient_id)"/,
      );
    });

    it('up() then down() issue matching, idempotent statements', async () => {
      for (const fn of ['up', 'down'] as const) {
        for (const c of await run(fn)) {
          expect(c).toMatch(/IF (NOT )?EXISTS/);
        }
      }
    });
  });
});
