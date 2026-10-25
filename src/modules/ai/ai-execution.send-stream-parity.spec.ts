import { ConfigService } from '@nestjs/config';

import { AiExecutionService } from './ai-execution.service';
import { AiPromptBudgetService } from './prompt/ai-prompt-budget.service';
import { currentPeriodMonth } from './ai.constants';
import { USAGE_METRIC } from '../subscription-billing/usage-metric';

/**
 * S-02 parity: `sendMessage` and `streamMessage` are two pipelines over the same
 * turn, so the same provider output must leave the same footprint on every
 * store they share — the persisted assistant row, the usage-log upsert, the
 * token-quota settlement and the metrics record.
 *
 * Written BEFORE the shared persistence/metering was extracted, and it must
 * pass unchanged both before and after. A divergence here is the failure mode
 * the audit named: a metering fix applied to one path only.
 */

const TENANT = 'clinic-a-tenant';
const CONVERSATION_ID = 'aiconv-1';
const PROMPT_TOKENS = 10;
const COMPLETION_TOKENS = 5;
const ANSWER = 'We open 9am to 10pm.';

interface Options {
  agent?: { id: string };
  fundedBy?: 'quota' | 'credit';
}

function build(opts: Options = {}) {
  const config = new ConfigService({});

  const aiConversations = {
    findOne: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      status: 'ACTIVE',
      channel: 'DASHBOARD',
      agent: opts.agent,
      conversation: undefined,
      session: undefined,
    }),
  };
  const created: Array<Record<string, unknown>> = [];
  const messages = {
    create: jest.fn((row: Record<string, unknown>) => {
      created.push(row);
      return row;
    }),
    save: jest
      .fn()
      .mockImplementation(async (row: Record<string, unknown>) => ({
        ...row,
        id: 'msg-1',
        created_at: new Date('2026-10-25T00:00:00Z'),
      })),
    find: jest.fn().mockResolvedValue([]),
  };
  const provider = {
    name: 'noop',
    complete: jest.fn().mockResolvedValue({
      content: ANSWER,
      model: 'gpt-4o',
      promptTokens: PROMPT_TOKENS,
      completionTokens: COMPLETION_TOKENS,
      toolCalls: [],
    }),
    stream: jest.fn().mockImplementation(async function* () {
      yield { delta: ANSWER };
      yield {
        delta: '',
        done: true,
        model: 'gpt-4o',
        usage: {
          promptTokens: PROMPT_TOKENS,
          completionTokens: COMPLETION_TOKENS,
        },
      };
    }),
  };
  const managerQuery = jest.fn().mockResolvedValue([]);
  const manager = { query: managerQuery, getRepository: () => messages };
  const dataSource = {
    query: jest.fn().mockResolvedValue([]),
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const usage = {
    incrementIfWithinLimit: jest
      .fn()
      .mockResolvedValue({ applied: true, fundedBy: opts.fundedBy ?? 'quota' }),
    increment: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    settleCreditRemainder: jest.fn().mockResolvedValue(undefined),
  };
  const metricsRecord = jest.fn().mockResolvedValue(undefined);
  const requests = {
    claim: jest.fn().mockResolvedValue('CLAIMED'),
    markProviderStarted: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
    completedResponse: jest.fn().mockResolvedValue(null),
    fail: jest.fn().mockResolvedValue(undefined),
  };
  const principal = { id: 'staff-1', guest: false, permissions: [] };

  const service = new AiExecutionService(
    aiConversations as never,
    messages as never,
    { retrieve: jest.fn().mockResolvedValue([]) } as never,
    { resolve: () => provider } as never,
    dataSource as never,
    usage as never,
    { execute: jest.fn() } as never,
    { getUser: () => principal, getCorrelationId: () => null } as never,
    {} as never,
    { record: metricsRecord } as never,
    { emit: jest.fn() } as never,
    new AiPromptBudgetService(config),
    {
      quoteChat: () => ({
        status: 'PRICED',
        provider: 'noop',
        requestedModel: 'gpt-4o',
        executionMode: 'STANDARD',
        costMicrousd: 0n,
      }),
      record: jest.fn().mockResolvedValue(undefined),
    } as never,
    requests as never,
    { resolve: () => ({ model: 'gpt-4o' }) } as never,
    {
      resolve: jest.fn().mockResolvedValue({
        executionMode: 'STANDARD',
        residencyRequired: false,
        region: null,
      }),
    } as never,
    {
      assertBillableActionAllowed: jest.fn().mockResolvedValue(undefined),
    } as never,
    { assertAccess: jest.fn().mockResolvedValue(undefined) } as never,
    config,
    { getTyped: jest.fn().mockResolvedValue(0.2) } as never,
    { describeSelection: jest.fn().mockResolvedValue(null) } as never,
    { findActiveForTurn: jest.fn().mockResolvedValue([]) } as never,
  );

  const dto = { content: 'ما هي مواعيد العمل؟' };
  const send = () => service.sendMessage(TENANT, CONVERSATION_ID, dto, 'REST');
  const stream = () =>
    service.streamMessage(TENANT, CONVERSATION_ID, dto, () => undefined);

  /** Everything the turn wrote, reduced to what must be path-independent. */
  const footprint = () => {
    const assistantRow = created.find((r) => r.role === 'assistant');
    const metric = metricsRecord.mock.calls[0]?.[0] ?? {};
    return {
      assistantRow,
      usageSql: managerQuery.mock.calls.map((c) => ({
        sql: String(c[0]).replace(/\s+/g, ' ').trim(),
        params: c[1],
      })),
      increments: usage.increment.mock.calls,
      creditSettlements: usage.settleCreditRemainder.mock.calls,
      released: usage.release.mock.calls,
      metric: {
        tenantId: metric.tenantId,
        aiConversationId: metric.aiConversationId,
        success: metric.success,
        promptTokens: metric.promptTokens,
        completionTokens: metric.completionTokens,
        costMicrousd: metric.costMicrousd,
        costUsd: metric.costUsd,
        pricingStatus: metric.pricingStatus,
        model: metric.model,
        actorUserId: metric.actorUserId,
      },
    };
  };

  return { send, stream, footprint, usage, metricsRecord, managerQuery };
}

describe('AiExecutionService — send vs stream parity (S-02)', () => {
  it.each([
    ['an agent-backed turn', { agent: { id: 'agent-1' } }],
    ['an agent-less turn (guest / no provisioned agent)', {}],
  ] as Array<[string, Options]>)(
    'persists identical rows and metering for %s',
    async (_label, opts) => {
      const a = build(opts);
      const b = build(opts);

      const sent = await a.send();
      const streamed = await b.stream();

      expect(sent.message.content).toBe(ANSWER);
      expect(streamed.message.content).toBe(ANSWER);
      expect(sent.usage).toEqual(streamed.usage);
      expect(sent.usage).toEqual({
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        totalTokens: PROMPT_TOKENS + COMPLETION_TOKENS,
      });
      expect(a.footprint()).toEqual(b.footprint());
    },
  );

  it('records the usage-log upsert against the turn tenant, agent and token total', async () => {
    const f = build({ agent: { id: 'agent-1' } });
    await f.send();

    expect(f.managerQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = f.managerQuery.mock.calls[0];
    expect(String(sql)).toContain('ON CONFLICT ("tenantId", "agentId", period_month)');
    expect(params).toEqual([
      TENANT,
      'agent-1',
      currentPeriodMonth(),
      PROMPT_TOKENS + COMPLETION_TOKENS,
    ]);
  });

  it('tops the 1-token reservation up to the real total on both paths, never releasing it', async () => {
    for (const run of ['send', 'stream'] as const) {
      const f = build();
      await f[run]();
      expect(f.usage.increment).toHaveBeenCalledWith(
        TENANT,
        USAGE_METRIC.AI_TOKENS,
        PROMPT_TOKENS + COMPLETION_TOKENS - 1,
      );
      expect(f.usage.release).not.toHaveBeenCalled();
    }
  });

  it('settles a credit-funded turn for its real remainder on both paths', async () => {
    const a = build({ fundedBy: 'credit' });
    const b = build({ fundedBy: 'credit' });
    await a.send();
    await b.stream();

    expect(a.usage.settleCreditRemainder).toHaveBeenCalledTimes(1);
    expect(a.usage.settleCreditRemainder.mock.calls).toEqual(
      b.usage.settleCreditRemainder.mock.calls,
    );
    expect(a.usage.settleCreditRemainder.mock.calls[0][2]).toBe(
      PROMPT_TOKENS + COMPLETION_TOKENS - 1,
    );
  });

  it('does not settle credit for a quota-funded turn on either path', async () => {
    for (const run of ['send', 'stream'] as const) {
      const f = build({ fundedBy: 'quota' });
      await f[run]();
      expect(f.usage.settleCreditRemainder).not.toHaveBeenCalled();
    }
  });
});
