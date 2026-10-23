/**
 * T125 — log, metric, and analytics hygiene (FR-083): no secrets, raw
 * sensitive payloads, full prompts carrying patient data, or embedding
 * vectors in `AiUsageLog` (`ai_usage_logs`), `AiCostLog` (`ai_cost_logs`),
 * `AiExecutionMetric` (`ai_execution_metrics`), or emitted logs.
 *
 * Structural fact established by reading the three entities
 * (`src/entities/AI Agent/{AiUsageLog,AiCostLog,AiExecutionMetric}.ts`):
 * NONE of them has a column typed to hold free-text prompt content or a
 * vector — `AiUsageLog`/`AiCostLog` are pure token/cost counters, and
 * `AiExecutionMetric.error_message` is the only free-text column. This spec
 * verifies that structural fact empirically: drives real turns (including a
 * failed one, and one carrying a synthetic-canary-shaped user message) and
 * scans the actual persisted rows plus everything printed to the console.
 *
 * GENUINE FINDING reproduced here (flagged, not hidden — see
 * `evidence/raw/candidates-w8.md` AI-W8-C03): the PERSISTED ROWS are clean,
 * but the raw console/stdout stream is not. This environment's `.env` has
 * `TYPEORM_LOGGING=true`, which wires TypeORM's own query logger
 * (`typeorm.config.ts:48,106`) to print every INSERT/UPDATE's full parameter
 * array — including the literal `content` of the `ai_messages` row this
 * turn just persisted (the user's raw message, canary included). This is a
 * platform-wide logging-configuration fact, not specific to any one table.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scanValue, scanText } from './fixtures/secret-scan';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiExecutionService } from '../../src/modules/ai/ai-execution.service';
import { validate } from '../../src/config/env.validation';

function captureConsole() {
  const lines: string[] = [];
  const methods: Array<'log' | 'warn' | 'error' | 'debug' | 'info'> = ['log', 'warn', 'error', 'debug', 'info'];
  const originals = methods.map((m) => console[m]);
  methods.forEach((m) => {
    jest.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  });
  return {
    text: () => lines.join('\n'),
    stop: () => methods.forEach((m, i) => (console[m] = originals[i])),
  };
}

/** A crude but sufficient shape-check for "this looks like a serialized embedding vector" (a long run of comma-separated floats). */
function looksLikeVectorDump(text: string): boolean {
  return /(-?0\.\d{3,},\s*){20,}/.test(text) || /\[(-?\d+\.\d+,\s*){20,}/.test(text);
}

describe('W8 — log, metric, and analytics hygiene (T125)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let execution: AiExecutionService;

  const CANARY = 'sk-audit-synthetic-canary-t125loghygiene';
  const SENSITIVE_MESSAGE = `My insurance number is INS-99881122 and my phone is +15551234567, also here is a token I found: ${CANARY}`;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    execution = harness.app.get(AiExecutionService);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('structural: none of the three tables has a column capable of holding a full prompt or an embedding vector', async () => {
    const cols = async (table: string) =>
      (
        await harness.dataSource.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
          [table],
        )
      ).map((r: { column_name: string; data_type: string }) => `${r.column_name}:${r.data_type}`);

    const usageCols = await cols('ai_usage_logs');
    const costCols = await cols('ai_cost_logs');
    const metricCols = await cols('ai_execution_metrics');

    // Only a column whose TYPE could actually hold free text or a vector is
    // "suspicious" — `embedding_tokens`/`batch_embedding_tokens` are legitimate
    // integer/bigint TOKEN COUNTS (not vectors), so a name-only check without
    // the type would false-positive on them.
    const suspicious = (c: string[]) =>
      c.filter((entry) => {
        const [name, type] = entry.split(':');
        const nameMatches = /content|prompt|message|embedding|vector/i.test(name);
        const typeCanHoldFreeTextOrVector = /text|character varying|jsonb|json|USER-DEFINED|ARRAY/i.test(type);
        return nameMatches && typeCanHoldFreeTextOrVector;
      });
    expect(suspicious(usageCols)).toEqual([]);
    expect(suspicious(costCols)).toEqual([]);
    // error_message is expected and is a free-text column — verified content-safe below.
    expect(suspicious(metricCols).every((c) => c.startsWith('error_message'))).toBe(true);
  });

  it('a turn carrying a synthetic-canary-shaped user message: the persisted AiExecutionMetric/AiUsageLog/AiCostLog rows for it carry no secret, no raw sensitive payload, no full prompt', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.script([{ content: 'Understood, thank you for sharing that.' }]);

    const console_ = captureConsole();
    await execution.sendMessage(seed.tenantA.id, conv.id, { content: SENSITIVE_MESSAGE }, 'REST');
    console_.stop();

    const metricRows = await harness.dataSource.query(
      `SELECT * FROM ai_execution_metrics WHERE "tenantId" = $1 AND "ai_conversation_id" = $2 ORDER BY created_at DESC LIMIT 5`,
      [seed.tenantA.id, conv.id],
    );
    expect(metricRows.length).toBeGreaterThan(0);
    const metricHits = scanValue(metricRows);
    expect(metricHits).toEqual([]);
    const metricText = JSON.stringify(metricRows);
    expect(metricText.includes(CANARY)).toBe(false);
    expect(metricText.includes(SENSITIVE_MESSAGE)).toBe(false);

    const usageRows = await harness.dataSource.query(
      `SELECT * FROM ai_usage_logs WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    expect(scanValue(usageRows)).toEqual([]);
    expect(JSON.stringify(usageRows).includes(CANARY)).toBe(false);

    const costRows = await harness.dataSource.query(
      `SELECT * FROM ai_cost_logs WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    expect(scanValue(costRows)).toEqual([]);
    expect(JSON.stringify(costRows).includes(CANARY)).toBe(false);

    // Emitted logs during the turn: the PERSISTED ROWS are clean (asserted
    // above), but the raw console/stdout stream is NOT — this is a genuine,
    // reproduced finding, not hidden: with TYPEORM_LOGGING=true (this
    // environment's actual .env value), TypeORM's own query logger
    // (`PlatformTools.logInfo`, `typeorm.config.ts:48,106` —
    // `logging: ['query','error','warn']`) prints the full PARAMETERS array
    // of every INSERT/UPDATE, including the literal `content` value of the
    // `ai_messages` row this turn just persisted — i.e. the user's raw
    // message, canary included. See `evidence/raw/candidates-w8.md` AI-W8-C03.
    const logText = console_.text();
    const logHits = scanText(logText);
    const canaryInLogs = logText.includes(CANARY);
    process.stdout.write(
      `\n===T125-OBSERVED metricHits=${metricHits.length} usageHits=0 costHits=0 rawConsoleLogHits=${logHits.length} canaryInRawConsoleLog=${canaryInLogs}===\n`,
    );
    // The hard assertion stays scoped to what this spec can respect without
    // rewriting an unrelated, pre-existing dev-time debug flag: no VECTOR
    // dump ever appears (that part IS clean — TypeORM logs parameter VALUES,
    // never a pgvector column's contents in a readable form in this harness),
    // and the finding above is drafted separately rather than silently
    // asserted away here.
    expect(looksLikeVectorDump(logText)).toBe(false);
    // AI-011 (T124/T125, RTP row 21, inverted 2026-08-17): this DEV/TEST
    // harness legitimately runs with TYPEORM_LOGGING=true, so a within-this-
    // file canary-in-console-output CANNOT be made to disappear here without
    // rewriting an unrelated dev-time debug convenience — that was never the
    // fix. The fix is that PRODUCTION can no longer boot with this
    // combination at all, checked directly below against the real
    // `env.validation.ts` boot gate rather than merely asserted in prose.

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('a FAILED turn: AiExecutionMetric.error_message is a fixed enum-like label, never the raw provider/driver error text', async () => {
    const conv = await conversations.start(seed.tenantA.id, { agentId: seed.tenantA.agentId });
    harness.provider.reset();
    harness.provider.scriptFailure({ kind: 'error', error: new Error('Simulated raw provider internals: connection to 10.0.4.17:5432 refused') });

    await expect(execution.sendMessage(seed.tenantA.id, conv.id, { content: SENSITIVE_MESSAGE }, 'REST')).rejects.toBeDefined();

    const metricRows = await harness.dataSource.query(
      `SELECT error_message FROM ai_execution_metrics WHERE "tenantId" = $1 AND "ai_conversation_id" = $2 AND success = false ORDER BY created_at DESC LIMIT 1`,
      [seed.tenantA.id, conv.id],
    );
    expect(metricRows.length).toBeGreaterThan(0);
    expect(metricRows[0].error_message).toMatch(/^AI_(PRE|PROVIDER_OR_POST)_PROVIDER_FAILURE$/);
    expect(metricRows[0].error_message.includes('10.0.4.17')).toBe(false);
    expect(metricRows[0].error_message.includes('Simulated raw provider internals')).toBe(false);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [conv.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  }, 30_000);

  it('ai_tool_calls (adjacent ledger, not one of the three target tables but worth checking): arguments/result are tenant-operational data, not a "log" — scanned anyway for platform-secret patterns', async () => {
    const rows = await harness.dataSource.query(
      `SELECT arguments, result, error FROM ai_tool_calls WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [seed.tenantA.id],
    );
    expect(scanValue(rows)).toEqual([]);
  });

  it('AI-011 (RTP row 21, inverted): a production boot with TYPEORM_LOGGING=true — the exact combination this file\'s canary reproduction depends on — now refuses to start, naming the offending setting', () => {
    const base = {
      DATABASE_URL: 'postgres://x',
      JWT_ACCESS_SECRET: 'secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      REDIS_URL: 'redis://localhost:6379',
      FRONTEND_ORIGIN: 'https://app.example.com',
      DB_SSL_CA: '/etc/ssl/certs/db-ca.pem',
      AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 1000,
      PAYMENT_PROVIDER: 'noop',
      ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };
    expect(() =>
      validate({ ...base, NODE_ENV: 'production', TYPEORM_LOGGING: 'true' }),
    ).toThrow(/TYPEORM_LOGGING/);
    // Non-production — this environment's own actual configuration — is
    // deliberately unaffected; that is what let this file's canary
    // reproduction above observe the raw console leak in the first place.
    expect(() =>
      validate({ ...base, NODE_ENV: 'development', TYPEORM_LOGGING: 'true' }),
    ).not.toThrow();
  });
});
