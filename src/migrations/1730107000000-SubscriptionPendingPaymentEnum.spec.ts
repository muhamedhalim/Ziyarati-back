import { SubscriptionPendingPaymentEnum1730107000000 as Migration } from './1730107000000-SubscriptionPendingPaymentEnum';

const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('SubscriptionPendingPaymentEnum migration (Tap Phase 3 / plan §17 M2)', () => {
  const upSql = async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new Migration().up({ query } as never);
    return query.mock.calls.map(([s]) => normalise(s as string));
  };

  it('has a class name and `name` property that agree (TypeORM keys migrations on `name`)', () => {
    expect(new Migration().name).toBe(
      'SubscriptionPendingPaymentEnum1730107000000',
    );
  });

  it('adds PENDING_PAYMENT to subscriptions_status_enum, idempotently', async () => {
    expect(await upSql()).toEqual([
      `ALTER TYPE "subscriptions_status_enum" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT'`,
    ]);
  });

  it('writes NO data — an enum value cannot be used in the transaction that adds it (data-model D-3)', async () => {
    const sql = (await upSql()).join(' ');
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });

  it('down() is a deliberate no-op: Postgres cannot drop an enum value', async () => {
    await expect(new Migration().down()).resolves.toBeUndefined();
  });
});
