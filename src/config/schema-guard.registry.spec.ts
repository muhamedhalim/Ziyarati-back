import { Logger } from '@nestjs/common';

import { SchemaGuardRegistry } from './schema-guard.registry';

/**
 * P0.3 SCHEMA-004 / RULE 5. The old bootstrap policy was a single
 * `catch { logger.warn(...) }` for every statement, so a missing money
 * idempotency guard and a missing dashboard index produced the identical
 * one-line warning. These tests pin the distinction that replaced it, and the
 * two properties that make it safe to ship: it never throws, and it never
 * leaks a database detail into the public readiness payload.
 */
describe('SchemaGuardRegistry', () => {
  let registry: SchemaGuardRegistry;
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    registry = new SchemaGuardRegistry();
    error = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const boom = () =>
    Promise.reject(new Error('duplicate key value violates uniqueness'));

  it('logs a FAILED required guard at error level, not warn', async () => {
    await registry.ensure({
      owner: 'PaymentsSchemaBootstrap',
      label: 'refund idempotency unique',
      criticality: 'required',
      run: boom,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toContain('INTEGRITY GUARD NOT INSTALLED');
    expect(error.mock.calls[0][0]).toContain('refund idempotency unique');
  });

  it('keeps a FAILED optional index at warn level — behaviour unchanged for performance indexes', async () => {
    await registry.ensure({
      owner: 'AnalyticsSchemaBootstrap',
      label: 'payments revenue index',
      criticality: 'optional',
      run: boom,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('NEVER throws — a missing index must not take a clinic offline mid-day', async () => {
    await expect(
      registry.ensure({
        owner: 'o',
        label: 'l',
        criticality: 'required',
        run: boom,
      }),
    ).resolves.toBe(false);
  });

  it('returns true on success and records nothing as failed', async () => {
    const ok = await registry.ensure({
      owner: 'o',
      label: 'l',
      criticality: 'required',
      run: async () => undefined,
    });
    expect(ok).toBe(true);
    expect(registry.failures()).toEqual([]);
    expect(registry.summary()).toEqual({
      status: 'ok',
      requiredChecked: 1,
      requiredFailed: 0,
    });
  });

  it('reports a BLOCKED guard distinctly from a failed one — conflicting data needs a decision, not a retry', () => {
    registry.reportBlocked({
      owner: 'ConversationsSchemaBootstrap',
      label: 'messages wa_message_id unique',
      criticality: 'required',
      conflicts: 189,
      detail: 'the same provider message is recorded twice',
    });
    const [f] = registry.failures();
    expect(f.status).toBe('blocked');
    expect(error.mock.calls[0][0]).toContain('BLOCKED BY EXISTING DATA');
    expect(error.mock.calls[0][0]).toContain('189 conflicting row(s)');
    // RULE 9 in one assertion: the message must say nothing was changed.
    expect(error.mock.calls[0][0]).toContain('No rows were changed');
  });

  it('counts required failures and marks the summary degraded', async () => {
    await registry.ensure({
      owner: 'o',
      label: 'a',
      criticality: 'required',
      run: boom,
    });
    await registry.ensure({
      owner: 'o',
      label: 'b',
      criticality: 'required',
      run: async () => 1,
    });
    await registry.ensure({
      owner: 'o',
      label: 'c',
      criticality: 'optional',
      run: boom,
    });
    expect(registry.summary()).toEqual({
      status: 'degraded',
      requiredChecked: 2,
      requiredFailed: 1,
    });
  });

  it('summary() leaks NO object name, table name or Postgres message — the readiness route is public', async () => {
    await registry.ensure({
      owner: 'PaymentsSchemaBootstrap',
      label: 'refund idempotency unique',
      criticality: 'required',
      run: () =>
        Promise.reject(
          new Error('relation "refunds" already has index uq_refund_idem'),
        ),
    });
    const serialised = JSON.stringify(registry.summary());
    expect(serialised).not.toMatch(
      /uq_refund_idem|refunds|idempotency|Payments/i,
    );
    // Only counts and a status word.
    expect(Object.keys(registry.summary()).sort()).toEqual([
      'requiredChecked',
      'requiredFailed',
      'status',
    ]);
  });

  it('failures() DOES carry the detail — that surface is operator-only', async () => {
    await registry.ensure({
      owner: 'PaymentsSchemaBootstrap',
      label: 'refund idempotency unique',
      criticality: 'required',
      run: boom,
    });
    expect(registry.failures()[0]).toMatchObject({
      label: 'refund idempotency unique',
      owner: 'PaymentsSchemaBootstrap',
      status: 'failed',
      detail: 'duplicate key value violates uniqueness',
    });
  });

  it('re-running the same guard replaces its outcome rather than double-counting it', async () => {
    const args = {
      owner: 'o',
      label: 'same',
      criticality: 'required' as const,
    };
    await registry.ensure({ ...args, run: boom });
    await registry.ensure({ ...args, run: async () => 1 });
    expect(registry.summary()).toEqual({
      status: 'ok',
      requiredChecked: 1,
      requiredFailed: 0,
    });
  });
});
