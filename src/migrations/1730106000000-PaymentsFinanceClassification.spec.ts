import { PaymentsFinanceClassification1730106000000 as Migration } from './1730106000000-PaymentsFinanceClassification';

const sqlOf = async (run: (q: { query: jest.Mock }) => Promise<void>) => {
  const query = jest.fn().mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('PaymentsFinanceClassification migration (Tap Phase 2 / plan §17 M1)', () => {
  const up = async () =>
    (await sqlOf((q) => new Migration().up(q as never))).map(normalise);
  const down = async () =>
    (await sqlOf((q) => new Migration().down(q as never))).map(normalise);

  it('has a class name and `name` property that agree (TypeORM keys migrations on `name`)', () => {
    expect(new Migration().name).toBe(
      'PaymentsFinanceClassification1730106000000',
    );
  });

  describe('up()', () => {
    it('adds the three columns idempotently, with the documented types and defaults', async () => {
      const calls = await up();
      expect(calls).toContainEqual(
        expect.stringContaining(
          `ADD COLUMN IF NOT EXISTS "purpose" varchar(24) NOT NULL DEFAULT 'BOOKING'`,
        ),
      );
      expect(calls).toContainEqual(
        expect.stringContaining(
          `ADD COLUMN IF NOT EXISTS "settlement_mode" varchar(16) NOT NULL DEFAULT 'INTERNAL'`,
        ),
      );
      expect(calls).toContainEqual(
        expect.stringContaining(
          `ADD COLUMN IF NOT EXISTS "fees_reconciled_at" timestamptz NULL`,
        ),
      );
    });

    it('adds the columns BEFORE any backfill, and the index AFTER them', async () => {
      const calls = await up();
      const idx = (needle: string) =>
        calls.findIndex((c) => c.includes(needle));
      const lastColumn = Math.max(
        idx(`"purpose" varchar`),
        idx(`"settlement_mode" varchar`),
        idx(`"fees_reconciled_at" timestamptz`),
      );
      expect(idx(`SET "purpose" = 'BILLING_UPGRADE'`)).toBeGreaterThan(
        lastColumn,
      );
      expect(idx(`SET "purpose" = 'ADDON'`)).toBeGreaterThan(lastColumn);
      expect(idx('CREATE INDEX')).toBeGreaterThan(
        idx(`SET "fees_reconciled_at"`),
      );
    });

    it('classifies billing-upgrade payments as platform revenue (settlement NONE) via the request→payment link', async () => {
      const stmt = (await up()).find((c) => c.includes(`'BILLING_UPGRADE'`))!;
      expect(stmt).toContain(`"settlement_mode" = 'NONE'`);
      expect(stmt).toContain('FROM "billing_upgrade_requests" b');
      expect(stmt).toContain('b."paymentId" = p."id"');
    });

    it('classifies resource add-on payments as platform revenue (settlement NONE) via the purchase→payment link', async () => {
      const stmt = (await up()).find((c) =>
        c.includes(`SET "purpose" = 'ADDON'`),
      )!;
      expect(stmt).toContain(`"settlement_mode" = 'NONE'`);
      expect(stmt).toContain('FROM "resource_purchases" r');
      expect(stmt).toContain('r."paymentId" = p."id"');
    });

    it('marks MANUAL only for a payment with no appointment that is still at the BOOKING default — never overriding a platform purpose', async () => {
      const stmt = (await up()).find((c) =>
        c.includes(`SET "purpose" = 'MANUAL'`),
      )!;
      expect(stmt).toContain(`"appointmentId" IS NULL`);
      expect(stmt).toContain(`"purpose" = 'BOOKING'`);
    });

    it('runs the platform-purpose backfills BEFORE the MANUAL one (so MANUAL cannot swallow an add-on)', async () => {
      const calls = await up();
      const idx = (needle: string) =>
        calls.findIndex((c) => c.includes(needle));
      expect(idx(`SET "purpose" = 'MANUAL'`)).toBeGreaterThan(
        idx(`'BILLING_UPGRADE'`),
      );
      expect(idx(`SET "purpose" = 'MANUAL'`)).toBeGreaterThan(
        idx(`SET "purpose" = 'ADDON'`),
      );
    });

    it('stamps fees_reconciled_at ONLY for historical Moyasar rows that carry a non-zero fee', async () => {
      const stmt = (await up()).find((c) =>
        c.includes(`SET "fees_reconciled_at"`),
      )!;
      expect(stmt).toContain(`"gateway" = 'moyasar'`);
      expect(stmt).toContain(`"gateway_fee" > 0`);
      expect(stmt).toContain(`"paid_at" IS NOT NULL`);
      expect(stmt).toContain(
        `"status" IN ('PAID', 'REFUNDED', 'PARTIALLY_REFUNDED')`,
      );
      expect(stmt).toContain(`"fees_reconciled_at" IS NULL`);
      // never claims a figure is final for the simulator or a future provider
      expect(stmt).not.toMatch(/noop|tap/i);
    });

    it('creates the (tenant, purpose, status) index under the name the entity declares', async () => {
      const stmt = (await up()).find((c) => c.includes('CREATE INDEX'))!;
      expect(stmt).toContain(
        'IF NOT EXISTS "idx_payments_tenant_purpose_status"',
      );
      expect(stmt).toContain('("tenantId", "purpose", "status")');
    });

    it('is additive: no DROP, DELETE, RENAME or TRUNCATE, and no write to settlement history', async () => {
      const text = (await up()).join('\n');
      expect(text).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
      expect(text).not.toMatch(/settlement_status/i);
      expect(text).not.toMatch(/gateway_payment_id/i); // no Moyasar id is ever rewritten
    });

    it('every backfill is a single set-based UPDATE (no loop to run away)', async () => {
      const updates = (await up()).filter((c) => c.startsWith('UPDATE'));
      expect(updates).toHaveLength(4);
    });
  });

  describe('down()', () => {
    it('drops only what up() added, index first', async () => {
      const calls = await down();
      expect(calls[0]).toContain(
        'DROP INDEX IF EXISTS "idx_payments_tenant_purpose_status"',
      );
      expect(calls.join('\n')).toContain(
        'DROP COLUMN IF EXISTS "fees_reconciled_at"',
      );
      expect(calls.join('\n')).toContain(
        'DROP COLUMN IF EXISTS "settlement_mode"',
      );
      expect(calls.join('\n')).toContain('DROP COLUMN IF EXISTS "purpose"');
      expect(calls).toHaveLength(4);
    });
  });
});
