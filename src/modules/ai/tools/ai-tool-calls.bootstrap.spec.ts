import { DataSource } from 'typeorm';

import { AiToolCallsBootstrap } from './ai-tool-calls.bootstrap';
import { SchemaGuardRegistry } from '../../../config/schema-guard.registry';

/**
 * P0.5 / P04-001 correction. `uq_ai_tool_call_idem` is a P0 guard in the
 * curated contract (`critical-schema-guards.json`) — the only thing
 * preventing a retried/duplicated AI-executed booking action from running
 * twice. It was being registered via `this.run` (`criticality: 'optional'`),
 * so its absence never degraded readiness like every other idempotency guard
 * in this codebase does. This is the only behaviour this spec pins — it does
 * not attempt to re-cover the bootstrap's other ten statements.
 */
describe('AiToolCallsBootstrap — uq_ai_tool_call_idem classification', () => {
  function fakeDataSource() {
    return {
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async () => undefined,
      }),
    } as unknown as DataSource;
  }

  it('registers uq_ai_tool_call_idem as required, not optional', async () => {
    const registry = new SchemaGuardRegistry();
    const ensureSpy = jest.spyOn(registry, 'ensure');

    await new AiToolCallsBootstrap(
      fakeDataSource(),
      registry,
    ).onApplicationBootstrap();

    const call = ensureSpy.mock.calls.find(
      ([opts]) => opts.label === 'ai_tool_calls idempotency unique',
    );
    expect(call).toBeDefined();
    expect(call?.[0].criticality).toBe('required');
  });

  it('a failure to install it degrades the registry summary (previously it could not)', async () => {
    const registry = new SchemaGuardRegistry();
    const dataSource = {
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async (sql: string) => {
          if (sql.includes('uq_ai_tool_call_idem')) {
            throw new Error('duplicate key value violates uniqueness');
          }
          return undefined;
        },
      }),
    } as unknown as DataSource;

    await new AiToolCallsBootstrap(
      dataSource,
      registry,
    ).onApplicationBootstrap();

    const summary = registry.summary();
    expect(summary.status).toBe('degraded');
    expect(summary.requiredFailed).toBeGreaterThanOrEqual(1);
  });
});
