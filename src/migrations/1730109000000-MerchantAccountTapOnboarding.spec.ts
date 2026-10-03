import { MerchantAccountTapOnboarding1730109000000 as Migration } from './1730109000000-MerchantAccountTapOnboarding';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const run = async (fn: 'up' | 'down') => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration()[fn]({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

describe('MerchantAccountTapOnboarding migration (Tap Phase 4 / plan §17 M1, merchant_accounts half)', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe(
      'MerchantAccountTapOnboarding1730109000000',
    );
  });

  describe('up()', () => {
    it('adds exactly four NULLABLE columns, idempotently — nothing is NOT NULL, so every existing account stays valid', async () => {
      const calls = await run('up');
      const alter = calls.find((c) =>
        c.startsWith('ALTER TABLE "merchant_accounts"'),
      )!;
      for (const col of [
        '"provider_lead_id" varchar(64)',
        '"provider_capabilities" jsonb',
        '"provider_callback_token_hash" varchar(64)',
        '"provider_onboarding_claimed_at" timestamptz',
      ]) {
        expect(alter).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      }
      expect(alter).not.toMatch(/NOT NULL/);
      expect(alter.match(/ADD COLUMN/g)).toHaveLength(4);
    });

    it("indexes the callback token hash with a PARTIAL UNIQUE index (only rows that have one), under the entity's name", async () => {
      const idx = (await run('up')).find((c) =>
        c.includes('UQ_merchant_accounts_callback_token_hash'),
      )!;
      expect(idx).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
      expect(idx).toContain('("provider_callback_token_hash")');
      expect(idx).toContain('WHERE "provider_callback_token_hash" IS NOT NULL');
    });

    it('does not touch the `provider` default or any existing value (no Moyasar id is rewritten)', async () => {
      const sql = (await run('up')).join(' ');
      expect(sql).not.toMatch(/\bUPDATE\b/i);
      expect(sql).not.toMatch(/DROP|RENAME|ALTER COLUMN/i);
      expect(sql).not.toContain('provider_recipient_id');
    });
  });

  describe('down()', () => {
    it('drops the index first, then only the columns this migration added', async () => {
      const calls = await run('down');
      expect(calls[0]).toContain(
        'DROP INDEX IF EXISTS "UQ_merchant_accounts_callback_token_hash"',
      );
      const alter = calls[1];
      for (const col of [
        'provider_onboarding_claimed_at',
        'provider_callback_token_hash',
        'provider_capabilities',
        'provider_lead_id',
      ]) {
        expect(alter).toContain(`DROP COLUMN IF EXISTS "${col}"`);
      }
      expect(alter.match(/DROP COLUMN/g)).toHaveLength(4);
    });
  });
});
