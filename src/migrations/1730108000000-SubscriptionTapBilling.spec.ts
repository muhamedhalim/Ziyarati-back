import { SubscriptionTapBilling1730108000000 as Migration } from './1730108000000-SubscriptionTapBilling';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

const run = async (fn: 'up' | 'down') => {
  const query = jest.fn().mockResolvedValue([]);
  await new Migration()[fn]({ query } as never);
  return query.mock.calls.map(([s]) => normalise(s as string));
};

describe('SubscriptionTapBilling migration (Tap Phase 3 / plan §17 M3)', () => {
  it('has a class name and `name` property that agree', () => {
    expect(new Migration().name).toBe('SubscriptionTapBilling1730108000000');
  });

  describe('up()', () => {
    it("adds the scheduled-downgrade column and its FK with ON DELETE SET NULL, idempotently, under the entity's constraint name", async () => {
      const calls = await run('up');
      expect(calls).toContainEqual(
        `ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "pending_plan_id" uuid`,
      );
      const fk = calls.find((c) =>
        c.includes('FK_subscriptions_pending_plan'),
      )!;
      expect(fk).toContain('IF NOT EXISTS');
      expect(fk).toContain(
        'FOREIGN KEY ("pending_plan_id") REFERENCES "subscription_plans"("id")',
      );
      expect(fk).toContain('ON DELETE SET NULL');
    });

    it('adds every invoice column the lifecycle needs, all nullable except the counter', async () => {
      const sql = (await run('up')).find((c) =>
        c.startsWith('ALTER TABLE "subscription_invoices"'),
      )!;
      for (const col of [
        `"kind" varchar(16)`,
        `"target_plan_id" uuid`,
        `"provider" varchar(32)`,
        `"payment_method_id" uuid`,
        `"checkout_charge_id" varchar(64)`,
        `"checkout_started_at" timestamptz`,
        `"checkout_attempts" integer NOT NULL DEFAULT 0`,
      ]) {
        expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
      }
      // nothing new is NOT NULL without a default: existing rows must stay valid
      expect(sql.match(/NOT NULL/g) ?? []).toHaveLength(1);
    });

    it('creates tenant_payment_methods with the three opaque gateway ids and NO card data', async () => {
      const sql = (await run('up')).find((c) =>
        c.includes('CREATE TABLE IF NOT EXISTS "tenant_payment_methods"'),
      )!;
      for (const col of [
        '"provider_customer_id" varchar(64) NOT NULL',
        '"provider_card_id" varchar(64) NOT NULL',
        '"provider_payment_agreement_id" varchar(96) NOT NULL',
        '"last_four" char(4)',
        '"recurring_capable" boolean NOT NULL DEFAULT true',
        '"is_default" boolean NOT NULL DEFAULT false',
        `"status" varchar(16) NOT NULL DEFAULT 'ACTIVE'`,
      ]) {
        expect(sql).toContain(col);
      }
      expect(sql).not.toMatch(
        /"(pan|card_number|cvv|cvc|exp_month|exp_year|expiry)"/i,
      );
      expect(sql).toContain('FK_tenant_payment_methods_tenant');
      expect(sql).toContain('ON DELETE CASCADE');
    });

    it('enforces one card id platform-wide and ONE active default per tenant, via the same index names the entity declares', async () => {
      const calls = await run('up');
      const card = calls.find((c) =>
        c.includes('UQ_tenant_payment_method_card'),
      )!;
      expect(card).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
      expect(card).toContain('("provider_card_id")');
      const def = calls.find((c) =>
        c.includes('UQ_tenant_payment_method_default'),
      )!;
      expect(def).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
      expect(def).toContain('("tenant_id")');
      expect(def).toContain(
        `WHERE "is_default" = true AND "status" = 'ACTIVE'`,
      );
    });

    it('creates the table BEFORE its indexes', async () => {
      const calls = await run('up');
      const at = (n: string) => calls.findIndex((c) => c.includes(n));
      expect(
        at('CREATE TABLE IF NOT EXISTS "tenant_payment_methods"'),
      ).toBeLessThan(at('UQ_tenant_payment_method_card'));
    });

    it('backfills NOTHING — legacy rows keep NULL, which is exactly how the code reads "legacy"', async () => {
      // statement-level: "ON UPDATE NO ACTION" inside an FK is not a data write
      for (const statement of await run('up')) {
        expect(statement).not.toMatch(/^(UPDATE|INSERT INTO|DELETE FROM)\b/i);
      }
    });

    it('does not touch the existing invoice uniqueness (UQ_sub_invoice_*)', async () => {
      const sql = (await run('up')).join(' ');
      expect(sql).not.toContain('UQ_sub_invoice');
    });
  });

  describe('down()', () => {
    it('drops only what up() added, idempotently', async () => {
      const calls = await run('down');
      expect(calls.join(' ')).toContain(
        'DROP TABLE IF EXISTS "tenant_payment_methods"',
      );
      const inv = calls.find((c) =>
        c.startsWith('ALTER TABLE "subscription_invoices"'),
      )!;
      for (const col of [
        'checkout_attempts',
        'checkout_started_at',
        'checkout_charge_id',
        'payment_method_id',
        'provider',
        'target_plan_id',
        'kind',
      ]) {
        expect(inv).toContain(`DROP COLUMN IF EXISTS "${col}"`);
      }
      expect(calls).toContainEqual(
        'ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "FK_subscriptions_pending_plan"',
      );
      expect(calls).toContainEqual(
        'ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "pending_plan_id"',
      );
    });

    it('drops the FK before the column it constrains', async () => {
      const calls = await run('down');
      const at = (n: string) => calls.findIndex((c) => c.includes(n));
      expect(
        at('DROP CONSTRAINT IF EXISTS "FK_subscriptions_pending_plan"'),
      ).toBeLessThan(at('DROP COLUMN IF EXISTS "pending_plan_id"'));
    });
  });
});
