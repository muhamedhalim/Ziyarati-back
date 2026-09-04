import { DataSource } from 'typeorm';

import { PaymentsSchemaBootstrap } from './payments-schema.bootstrap';
import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * P0.3 SCHEMA-004 (criticality split) and FIX-002 (the atomic trigger).
 *
 * The money-critical guards in this file — `uq_refund_idem`,
 * `uq_txn_webhook_event`, `uq_payments_appointment_pending`,
 * `uq_settlement_adj_refund` — are exactly the ones P0.2 found surviving a
 * synchronize boot ONLY because this bootstrap re-creates them, while failing
 * silently if it could not.
 */
describe('PaymentsSchemaBootstrap (P0.3)', () => {
  let issued: string[];
  let guards: SchemaGuardRegistry;

  const dsThatFails = (predicate: (sql: string) => boolean) =>
    ({
      query: async (sql: string) => {
        issued.push(sql);
        if (predicate(sql)) throw new Error('permission denied for relation');
        return [];
      },
    }) as unknown as DataSource;

  beforeEach(() => {
    issued = [];
    guards = new SchemaGuardRegistry();
    jest.spyOn(guards, 'ensure');
  });

  afterEach(() => jest.restoreAllMocks());

  it('classifies the money-critical uniqueness guards as REQUIRED', async () => {
    await new PaymentsSchemaBootstrap(
      dsThatFails(() => false),
      guards,
    ).onApplicationBootstrap();
    const required = (guards.ensure as jest.Mock).mock.calls
      .map(([a]) => a)
      .filter((a) => a.criticality === 'required')
      .map((a) => a.label);
    expect(required).toEqual(
      expect.arrayContaining([
        'refund idempotency unique',
        'refund gateway-id unique',
        'webhook dedup unique',
        'one pending payment per appointment',
        'settlement_adjustments refund unique',
        'transactions immutability trigger',
      ]),
    );
  });

  it('classifies the supporting lookup indexes as OPTIONAL', async () => {
    await new PaymentsSchemaBootstrap(
      dsThatFails(() => false),
      guards,
    ).onApplicationBootstrap();
    const optional = (guards.ensure as jest.Mock).mock.calls
      .map(([a]) => a)
      .filter((a) => a.criticality === 'optional')
      .map((a) => a.label);
    expect(optional).toEqual(
      expect.arrayContaining([
        'refund aggregation index',
        'transaction payment index',
        'settlement claim index',
        'settlement_adjustments open index',
      ]),
    );
  });

  it('a failing REQUIRED guard degrades readiness; a failing OPTIONAL index does not', async () => {
    const onlyOptionalFails = dsThatFails((sql) =>
      sql.includes('idx_refund_payment_status'),
    );
    await new PaymentsSchemaBootstrap(
      onlyOptionalFails,
      guards,
    ).onApplicationBootstrap();
    expect(guards.summary().status).toBe('ok');

    const g2 = new SchemaGuardRegistry();
    issued = [];
    const requiredFails = dsThatFails((sql) => sql.includes('uq_refund_idem'));
    await new PaymentsSchemaBootstrap(
      requiredFails,
      g2,
    ).onApplicationBootstrap();
    expect(g2.summary().status).toBe('degraded');
    expect(g2.failures().map((f) => f.label)).toEqual([
      'refund idempotency unique',
    ]);
  });

  it('recreates the append-only trigger ATOMICALLY — the DROP can no longer outlive a failed CREATE', async () => {
    await new PaymentsSchemaBootstrap(
      dsThatFails(() => false),
      guards,
    ).onApplicationBootstrap();
    const trigger = issued.filter((s) => s.includes('transactions_no_mutate'));
    // ONE statement, containing both halves inside a DO block. Two independent
    // statements meant a failed CREATE left the ledger with no append-only
    // protection at all — the bootstrap could make the database LESS protected
    // than it found it.
    expect(trigger).toHaveLength(1);
    expect(trigger[0]).toMatch(/DO \$do\$/);
    expect(trigger[0]).toMatch(/DROP TRIGGER IF EXISTS transactions_no_mutate/);
    expect(trigger[0]).toMatch(/CREATE TRIGGER transactions_no_mutate/);
  });

  it('issues no data-modifying statement', async () => {
    await new PaymentsSchemaBootstrap(
      dsThatFails(() => false),
      guards,
    ).onApplicationBootstrap();
    // Matched on the leading verb of each statement, not anywhere in the text:
    // the append-only trigger's own body legitimately contains the words
    // `UPDATE OR DELETE` while modifying nothing. `CREATE TABLE` and `ALTER
    // TABLE … ADD COLUMN IF NOT EXISTS` are schema statements, not data ones.
    const mutating = issued.filter((sql) =>
      /^(DELETE|UPDATE|INSERT|TRUNCATE)\b/i.test(sql.trim()),
    );
    expect(mutating).toEqual([]);
  });
});
