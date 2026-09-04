import { DataSource } from 'typeorm';

import { ConversationsSchemaBootstrap } from './conversations-schema.bootstrap';
import { SchemaGuardRegistry } from '../../config/schema-guard.registry';

/**
 * P0.3 FIX-003 / RULE 9. This bootstrap used to run, unconditionally and on
 * every boot in every environment including production:
 *
 *   DELETE FROM messages a USING messages b
 *    WHERE a.ctid > b.ctid AND a."tenantId" = b."tenantId"
 *      AND a.wa_message_id = b.wa_message_id AND a.wa_message_id IS NOT NULL
 *
 * — destroying customer message rows to make a `CREATE UNIQUE INDEX` succeed,
 * choosing the survivor by `ctid` (the row's PHYSICAL location, which changes
 * on any UPDATE and on VACUUM FULL, so the choice was not even deterministic),
 * and swallowing the row count. The first test below is the one that matters:
 * the bootstrap must never issue a data-modifying statement again.
 */
describe('ConversationsSchemaBootstrap (P0.3)', () => {
  let issued: string[];
  let guards: SchemaGuardRegistry;
  let bootstrap: ConversationsSchemaBootstrap;
  let conflictRows: Array<Record<string, unknown>>;

  const makeDataSource = () =>
    ({
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async (sql: string) => {
          issued.push(sql);
          // Any statement that counts conflicts returns the scripted result;
          // everything else (the CREATEs) succeeds.
          return /GROUP BY/i.test(sql) ? conflictRows : [];
        },
      }),
    }) as unknown as DataSource;

  beforeEach(() => {
    issued = [];
    conflictRows = [{ excess: '0' }];
    guards = new SchemaGuardRegistry();
    jest.spyOn(guards, 'reportBlocked');
    bootstrap = new ConversationsSchemaBootstrap(makeDataSource(), guards);
  });

  afterEach(() => jest.restoreAllMocks());

  it('issues NO data-modifying statement, ever', async () => {
    await bootstrap.onApplicationBootstrap();
    const mutating = issued.filter((sql) =>
      /\b(DELETE|UPDATE|INSERT|TRUNCATE|DROP)\b/i.test(sql),
    );
    expect(mutating).toEqual([]);
  });

  it('creates both uniqueness guards when no conflicts exist', async () => {
    await bootstrap.onApplicationBootstrap();
    expect(issued.some((s) => s.includes('uq_message_wa_id'))).toBe(true);
    expect(issued.some((s) => s.includes('uq_message_status'))).toBe(true);
    expect(guards.summary()).toMatchObject({ status: 'ok', requiredFailed: 0 });
  });

  it('when conflicts exist: does NOT attempt the index, and reports it blocked with the count', async () => {
    conflictRows = [{ excess: '189' }];
    await bootstrap.onApplicationBootstrap();

    expect(issued.some((s) => s.includes('CREATE UNIQUE INDEX'))).toBe(false);
    expect(guards.reportBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ conflicts: 189, criticality: 'required' }),
    );
    expect(guards.summary()).toMatchObject({ status: 'degraded' });
  });

  it('the conflict pre-check reproduces PostgreSQL uniqueness semantics — NULL keys are exempt', async () => {
    await bootstrap.onApplicationBootstrap();
    const check = issued.find((s) =>
      s.includes('GROUP BY "tenantId", wa_message_id'),
    );
    // A unique index treats NULLs as DISTINCT, so a group whose key contains a
    // NULL is never a conflict. Counting it would report a phantom blocker and
    // refuse to install an index that would in fact have succeeded.
    expect(check).toMatch(/wa_message_id IS NOT NULL/);
    expect(check).toMatch(/"tenantId" IS NOT NULL/);
  });

  it('the inbox index stays OPTIONAL — a performance index must not degrade readiness', async () => {
    const ds = {
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => undefined,
        query: async (sql: string) => {
          if (/GROUP BY/i.test(sql)) return [{ excess: '0' }];
          if (sql.includes('idx_conversations_tenant_lastmsg')) {
            throw new Error('permission denied');
          }
          return [];
        },
      }),
    } as unknown as DataSource;
    await new ConversationsSchemaBootstrap(ds, guards).onApplicationBootstrap();
    expect(guards.summary()).toMatchObject({ status: 'ok', requiredFailed: 0 });
  });
});
