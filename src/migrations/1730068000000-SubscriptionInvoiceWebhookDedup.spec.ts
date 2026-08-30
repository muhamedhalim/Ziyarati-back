import { SubscriptionInvoiceWebhookDedup1730068000000 } from './1730068000000-SubscriptionInvoiceWebhookDedup';

const sqlOf = async (
  run: (q: { query: jest.Mock }) => Promise<void>,
  responses: unknown[] = [],
) => {
  const query = jest.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  query.mockResolvedValue([]);
  await run({ query } as never);
  return query.mock.calls.map(([statement]) => statement as string);
};

describe('SubscriptionInvoiceWebhookDedup migration', () => {
  it('adds the webhook_event_id column', async () => {
    const statements = await sqlOf(
      (q) => new SubscriptionInvoiceWebhookDedup1730068000000().up(q as never),
      [[], [], [{ indisvalid: true }]],
    );
    expect(statements[0]).toContain(
      'ADD COLUMN IF NOT EXISTS "webhook_event_id" varchar',
    );
  });

  it('creates the partial unique index scoped to non-null webhook_event_id', async () => {
    const statements = await sqlOf(
      (q) => new SubscriptionInvoiceWebhookDedup1730068000000().up(q as never),
      [[], [], [{ indisvalid: true }]],
    );
    const indexStatement = statements.find((s) =>
      s.includes('UQ_sub_invoice_webhook_event'),
    );
    expect(indexStatement).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(indexStatement).toContain('"webhook_event_id" IS NOT NULL');
  });

  it('aborts if the CONCURRENTLY index build is left invalid', async () => {
    await expect(
      sqlOf(
        (q) =>
          new SubscriptionInvoiceWebhookDedup1730068000000().up(q as never),
        [[], [], [{ indisvalid: false }]],
      ),
    ).rejects.toThrow(/was created but is NOT valid/);
  });

  it('down drops the index and the column', async () => {
    const statements = await sqlOf((q) =>
      new SubscriptionInvoiceWebhookDedup1730068000000().down(q as never),
    );
    expect(statements[0]).toBe(
      'DROP INDEX IF EXISTS "UQ_sub_invoice_webhook_event"',
    );
    expect(statements[1]).toContain('DROP COLUMN IF EXISTS "webhook_event_id"');
  });

  it('does not run inside a transaction — CONCURRENTLY cannot', () => {
    expect(new SubscriptionInvoiceWebhookDedup1730068000000().transaction).toBe(
      false,
    );
  });
});
