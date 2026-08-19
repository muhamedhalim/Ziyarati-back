import { SubscriptionPlanFileLimitsBigint1730051000000 } from './1730051000000-SubscriptionPlanFileLimitsBigint';

describe('SubscriptionPlanFileLimitsBigint migration', () => {
  it('widens both file-limit columns to bigint', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new SubscriptionPlanFileLimitsBigint1730051000000().up({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE "subscription_plans" ALTER COLUMN "max_uploaded_files" TYPE bigint',
    );
    expect(sql).toContain(
      'ALTER TABLE "subscription_plans" ALTER COLUMN "max_training_files" TYPE bigint',
    );
  });

  it('down reverts both columns back to integer', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await new SubscriptionPlanFileLimitsBigint1730051000000().down({ query } as any);
    const sql = query.mock.calls.map(([statement]) => statement).join('\n');

    expect(sql).toContain(
      'ALTER TABLE "subscription_plans" ALTER COLUMN "max_uploaded_files" TYPE integer',
    );
    expect(sql).toContain(
      'ALTER TABLE "subscription_plans" ALTER COLUMN "max_training_files" TYPE integer',
    );
  });
});
