import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigService } from '@nestjs/config';

import { AiExecutionService } from './ai-execution.service';
import { SendMessageDto } from './dto/send-message.dto';
import { AiPromptBudgetService } from './prompt/ai-prompt-budget.service';
import {
  CLINIC_INSTRUCTIONS_HEADER,
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
} from './prompt/default-system-prompt';
import {
  AI_PUBLIC_BOOKING_TOOLS,
  AI_PUBLIC_TOOL,
} from './tools/ai-public-booking-tools.constants';
import { AI_TOOL, AI_TOOLS } from './tools/ai-tools.constants';
import { SESSION_CLIENT_PATCHABLE_KEYS } from '../ai-orchestrator/ai-channel.constants';

/**
 * Knowledge/RAG reachability, end to end through the real `sendMessage`.
 *
 * These drive the actual turn — not a helper in isolation — because the bug
 * being pinned was a single `agent ? … : []` guard around the retrieval call:
 * every collaborator downstream of it behaved perfectly, which is exactly why
 * the failure was invisible to unit tests of `AiRagService` itself.
 *
 * `AiPromptBudgetService` is the REAL implementation so the assembled prompt is
 * a genuine artefact: what these tests read off `provider.complete` is what the
 * model would have been sent.
 */

const CLINIC_TENANT = 'clinic-a-tenant';
const OTHER_CLINIC_TENANT = 'clinic-b-tenant';
const DISCOVERY_TENANT = 'guest-discovery-tenant';
const CONVERSATION_ID = 'aiconv-1';

interface Options {
  /** Conversation tenant: the clinic itself, or the guest discovery tenant. */
  tenantId?: string;
  agent?: { id: string; system_prompt?: string; model?: string };
  session?: Record<string, unknown>;
  guest?: boolean;
  chunks?: Array<{ id: string; content: string; score: number }>;
  /** Tenants the public-bookability re-check accepts as still eligible. */
  eligibleClinics?: string[];
  /**
   * Scripted provider replies, one per tool-loop iteration. Lets a test drive
   * the model into calling a tool and then answering, without a live provider.
   */
  script?: Array<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  }>;
  /** What `AiToolDispatchService.execute` returns for each call. */
  toolResult?: Record<string, unknown>;
  /** Fixed server-verified booking block for every turn/iteration. */
  bookingContext?: string | null;
  /** Per-call booking blocks, so a mid-loop refresh can be observed. */
  bookingContexts?: Array<string | null>;
}

function build(opts: Options = {}) {
  const tenantId = opts.tenantId ?? CLINIC_TENANT;
  const config = new ConfigService({});

  const aiConversations = {
    findOne: jest.fn().mockResolvedValue({
      id: CONVERSATION_ID,
      status: 'ACTIVE',
      channel: opts.guest ? 'WEBSITE' : 'DASHBOARD',
      agent: opts.agent,
      conversation: undefined,
      session: opts.session,
    }),
  };
  const messages = {
    create: jest.fn((row: Record<string, unknown>) => row),
    save: jest
      .fn()
      .mockImplementation(async (row: Record<string, unknown>) => ({
        ...row,
        id: 'msg-1',
        created_at: new Date(),
      })),
    find: jest.fn().mockResolvedValue([]),
  };
  const rag = { retrieve: jest.fn().mockResolvedValue(opts.chunks ?? []) };
  const script = opts.script ?? [{ content: 'answer' }];
  let loop = 0;
  const provider = {
    name: 'noop',
    complete: jest.fn().mockImplementation(async () => {
      const step = script[Math.min(loop, script.length - 1)];
      loop += 1;
      return {
        content: step.content,
        model: 'gpt-4o',
        promptTokens: 10,
        completionTokens: 5,
        toolCalls: step.toolCalls ?? [],
      };
    }),
  };
  const dispatch = {
    execute: jest
      .fn()
      .mockResolvedValue(opts.toolResult ?? { success: true, cities: [] }),
  };
  const eligible = new Set(opts.eligibleClinics ?? []);
  const manager = {
    query: jest.fn().mockResolvedValue([]),
    getRepository: () => messages,
  };
  const dataSource = {
    // The only raw query `sendMessage` itself issues is the public-bookability
    // re-check inside `resolveKnowledgeScope`.
    query: jest
      .fn()
      .mockImplementation(async (_sql: string, params: unknown[]) =>
        eligible.has(params[0] as string) ? [{ id: params[0] }] : [],
      ),
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb(manager),
    ),
  };
  const principal = opts.guest
    ? { id: 'guest-sub', guest: true, permissions: [] }
    : { id: 'staff-1', guest: false, permissions: [] };
  /**
   * The server-verified booking block. Scripted per call so a test can make a
   * `select_*` inside the tool loop change what the next iteration is told,
   * which is the whole point of the mid-loop refresh.
   */
  const describeSelection = jest.fn().mockImplementation(async () => {
    const next = (opts.bookingContexts ?? [])[
      Math.min(
        describeSelection.mock.calls.length - 1,
        (opts.bookingContexts?.length ?? 1) - 1,
      )
    ];
    return next ?? opts.bookingContext ?? null;
  });
  const bookingContext = { describeSelection };

  const service = new AiExecutionService(
    aiConversations as never,
    messages as never,
    rag as never,
    { resolve: () => provider } as never,
    dataSource as never,
    {
      incrementIfWithinLimit: jest.fn().mockResolvedValue({ applied: true }),
      increment: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as never,
    dispatch as never,
    {
      getUser: () => principal,
      getCorrelationId: () => null,
    } as never,
    {} as never, // timeline — no linked messaging conversation
    { record: jest.fn().mockResolvedValue(undefined) } as never,
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
    {
      claim: jest.fn().mockResolvedValue('CLAIMED'),
      markProviderStarted: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn().mockResolvedValue(undefined),
      completedResponse: jest.fn().mockResolvedValue(null),
      fail: jest.fn().mockResolvedValue(undefined),
    } as never,
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
    bookingContext as never,
  );

  const turn = () =>
    service.sendMessage(
      tenantId,
      CONVERSATION_ID,
      { content: 'ما هي مواعيد العمل؟' },
      'REST',
    );

  /** Messages handed to the provider on tool-loop iteration `call`. */
  const sentMessages = (
    call = 0,
  ): Array<{ role: string; content: string | null }> =>
    provider.complete.mock.calls[call]?.[0]?.messages ?? [];

  /** The `system` message actually handed to the provider. */
  const systemMessage = (call = 0): string | undefined =>
    sentMessages(call).find((m) => m.role === 'system')?.content ?? undefined;

  /** The `<knowledge>` block actually handed to the provider, if any. */
  const knowledgeMessage = (call = 0): string | undefined =>
    sentMessages(call).find(
      (m) => m.role === 'user' && !!m.content?.includes('<knowledge>'),
    )?.content ?? undefined;

  const toolNames = (call = 0): string[] =>
    (provider.complete.mock.calls[call]?.[0]?.tools ?? []).map(
      (t: { name: string }) => t.name,
    );

  /**
   * Every `system` message handed to the provider on iteration `call`. The
   * booking block is pinned as a SECOND system message, so a test asserting it
   * survived truncation has to look past the first one.
   */
  const systemMessages = (call = 0): string[] =>
    sentMessages(call)
      .filter((m) => m.role === 'system')
      .map((m) => m.content ?? '');

  return {
    service,
    turn,
    rag,
    provider,
    dispatch,
    dataSource,
    manager,
    describeSelection,
    sentMessages,
    systemMessage,
    systemMessages,
    knowledgeMessage,
    toolNames,
  };
}

// ───────────────────── Dashboard assistant (authenticated) ──────────────────

describe('Dashboard assistant — Knowledge is reachable without an agent', () => {
  it("retrieves the tenant's Knowledge even though no AiAgent is provisioned", async () => {
    const f = build({
      chunks: [
        { id: 'kb-1', content: 'We open 9am–10pm, closed Friday.', score: 0.9 },
      ],
    });

    await f.turn();

    // The gate that used to short-circuit this to `[]` is gone.
    expect(f.rag.retrieve).toHaveBeenCalledTimes(1);
    expect(f.rag.retrieve.mock.calls[0][0]).toBe(CLINIC_TENANT);
    expect(f.rag.retrieve.mock.calls[0][1]).toBeNull(); // agentId — explicit null
  });

  it('puts the retrieved chunks into the prompt the model actually receives', async () => {
    const f = build({
      chunks: [
        { id: 'kb-1', content: 'We open 9am–10pm, closed Friday.', score: 0.9 },
      ],
    });

    await f.turn();

    expect(f.knowledgeMessage()).toContain('We open 9am–10pm, closed Friday.');
  });

  it('reports the retrieved chunk count back to the caller (no longer always 0)', async () => {
    const f = build({
      chunks: [
        { id: 'kb-1', content: 'a', score: 0.9 },
        { id: 'kb-2', content: 'b', score: 0.8 },
      ],
    });

    await expect(f.turn()).resolves.toMatchObject({ retrievedChunks: 2 });
  });

  it('still passes the agent id when one IS provisioned (unchanged behaviour)', async () => {
    const f = build({ agent: { id: 'agent-1' } });

    await f.turn();

    expect(f.rag.retrieve.mock.calls[0][1]).toBe('agent-1');
  });
});

// ─────────────────────────── Public chatbot (guest) ─────────────────────────

describe('Public chatbot — Knowledge scope follows the selected clinic', () => {
  it('does NOT reach any clinic Knowledge before a clinic has been selected', async () => {
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub' },
      eligibleClinics: [CLINIC_TENANT],
    });

    await f.turn();

    // Scope stays the data-less discovery tenant — never a clinic.
    expect(f.rag.retrieve.mock.calls[0][0]).toBe(DISCOVERY_TENANT);
    expect(f.rag.retrieve.mock.calls[0][0]).not.toBe(CLINIC_TENANT);
    // No eligibility probe is even issued when nothing is selected.
    expect(f.dataSource.query).not.toHaveBeenCalled();
  });

  it("retrieves the SELECTED clinic's Knowledge once select_clinic has recorded one", async () => {
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
      chunks: [{ id: 'kb-1', content: 'Clinic A opens at 9am.', score: 0.9 }],
    });

    await f.turn();

    expect(f.rag.retrieve.mock.calls[0][0]).toBe(CLINIC_TENANT);
    expect(f.knowledgeMessage()).toContain('Clinic A opens at 9am.');
  });

  it('re-validates the recorded clinic against live data every turn, not just at selection time', async () => {
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
    });

    await f.turn();

    const [sql, params] = f.dataSource.query.mock.calls[0];
    expect(params).toEqual([CLINIC_TENANT]);
    expect(sql).toContain('public_booking_enabled');
    expect(sql).toContain("approval_status = 'APPROVED'");
    expect(sql).toContain('deleted_at IS NULL');
  });

  it('falls back to the discovery tenant when the selected clinic has since opted out (fails closed)', async () => {
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [], // no longer publicly bookable
    });

    await f.turn();

    expect(f.rag.retrieve.mock.calls[0][0]).toBe(DISCOVERY_TENANT);
  });
});

// ───────────────────────────── Tenant isolation ─────────────────────────────

describe("Tenant isolation — one clinic can never read another clinic's Knowledge", () => {
  it('scopes retrieval to exactly one tenant id per turn', async () => {
    const f = build({ tenantId: CLINIC_TENANT });

    await f.turn();

    const scope = f.rag.retrieve.mock.calls[0][0];
    expect(typeof scope).toBe('string');
    expect(scope).toBe(CLINIC_TENANT);
    expect(scope).not.toBe(OTHER_CLINIC_TENANT);
  });

  it('never lets an authenticated clinic turn be re-scoped by a stray session value', async () => {
    const f = build({
      tenantId: CLINIC_TENANT,
      // Clinic B's id sitting in Clinic A's session must not redirect retrieval.
      session: { selectedClinicId: OTHER_CLINIC_TENANT },
      eligibleClinics: [], // B is not publicly bookable → re-check rejects it
    });

    await f.turn();

    expect(f.rag.retrieve.mock.calls[0][0]).toBe(CLINIC_TENANT);
  });

  it('`selectedClinicId` is server-write-only — a client sessionPatch can never set it', () => {
    // This is what makes it safe to scope retrieval on: `patchFromClient`
    // drops every key absent from this allowlist.
    expect(SESSION_CLIENT_PATCHABLE_KEYS).not.toContain('selectedClinicId');
    expect(SESSION_CLIENT_PATCHABLE_KEYS).not.toContain('selectedBranchId');
  });
});

// ───────────────────────────── Default system prompt ────────────────────────

describe('Default system prompt — agent-less turns are no longer instruction-free', () => {
  it('sends the assistant prompt on an authenticated turn with no agent', async () => {
    const f = build();

    await f.turn();

    expect(f.systemMessage()).toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT);
  });

  it('sends the public-booking prompt on a guest turn with no agent', async () => {
    const f = build({ tenantId: DISCOVERY_TENANT, guest: true });

    await f.turn();

    expect(f.systemMessage()).toBe(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT);
  });

  it("F-12: an agent's own prompt is added ON TOP of the platform default, never in place of it", async () => {
    const f = build({
      agent: {
        id: 'agent-1',
        system_prompt: "You are Dr. Nour's receptionist.",
      },
    });

    await f.turn();

    const sent = f.systemMessage();
    // The core comes first, whole — the safety, scope and no-invention rules survive.
    expect(sent.startsWith(DEFAULT_ASSISTANT_SYSTEM_PROMPT)).toBe(true);
    expect(sent).toContain('CLINICAL SAFETY');
    // The clinic's text follows, framed as subordinate to it.
    expect(sent).toContain(CLINIC_INSTRUCTIONS_HEADER);
    expect(sent.endsWith("You are Dr. Nour's receptionist.")).toBe(true);
  });

  it('falls back to the default when an agent exists but carries a blank prompt', async () => {
    const f = build({ agent: { id: 'agent-1', system_prompt: '   ' } });

    await f.turn();

    expect(f.systemMessage()).toBe(DEFAULT_ASSISTANT_SYSTEM_PROMPT);
  });

  it('tells the model to answer from <knowledge> and never to invent facts', () => {
    for (const prompt of [
      DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
    ]) {
      expect(prompt).toContain('<knowledge>');
      expect(prompt).toMatch(/Answer from it directly/);
      expect(prompt).toMatch(/Never invent facts/);
      // The precedence rule, which <knowledge> alone could not give: a clinic's
      // hours, address, prices and free times are read from the DATABASE even
      // when a Knowledge document also mentions them. Without this the model
      // could answer "what are your hours?" from a stale document while a
      // `get_branch_info` call sat unused.
      expect(prompt).toMatch(/LIVE FACTS COME FROM A TOOL/);
    }
  });

  it('tells the public assistant not to call list_cities for an informational question', () => {
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /do NOT call list_cities/,
    );
    // Same rule as before, now stated in both directions: an empty tool result
    // never erases <knowledge>, and <knowledge> never establishes bookability.
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /empty tool result never erases what <knowledge> says/,
    );
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /absent from search_clinics is NOT bookable/,
    );
    // And each informational question now routes to the tool that can actually
    // answer it, rather than to <knowledge> alone (which most clinics never
    // populate) or to an availability check (which answers a different
    // question entirely).
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /what are your hours[\s\S]*-> get_branch_info/,
    );
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /when does Dr X work[\s\S]*-> get_doctor_schedule/,
    );
    // Booking is still explicitly a tool job — the prompt must not talk the
    // model out of the booking flow it is there to run.
    expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toMatch(
      /book_public_appointment/,
    );
  });

  it('does not mention list_cities to the dashboard assistant, which is never offered it', async () => {
    const f = build();

    await f.turn();

    expect(f.systemMessage()).not.toContain(AI_PUBLIC_TOOL.LIST_CITIES);
    expect(f.toolNames()).not.toContain(AI_PUBLIC_TOOL.LIST_CITIES);
  });
});

// ──────────────────────────────── Usage metering ────────────────────────────

describe('Usage metering — no longer silently skipped on agent-less turns', () => {
  it('records the turn with a NULL agent instead of not recording it at all', async () => {
    const f = build();

    await f.turn();

    const usageWrites = f.manager.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('ai_usage_logs'),
    );
    expect(usageWrites.length).toBeGreaterThan(0);
    // UPDATE-then-INSERT: Postgres treats NULLs as distinct, so the agent-bound
    // ON CONFLICT target can never match an agent-less row.
    expect(usageWrites[0][0]).toContain('"agentId" IS NULL');
    expect(usageWrites[0][1]).toEqual([CLINIC_TENANT, expect.any(String), 15]);
  });

  it('inserts only when the period row does not exist yet', async () => {
    const f = build();
    f.manager.query.mockResolvedValue([]); // UPDATE matched nothing

    await f.turn();

    const usageWrites = f.manager.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('ai_usage_logs'),
    );
    expect(usageWrites).toHaveLength(2);
    expect(usageWrites[0][0]).toContain('UPDATE ai_usage_logs');
    expect(usageWrites[1][0]).toContain('INSERT INTO ai_usage_logs');
  });

  it('skips the INSERT when the UPDATE already incremented an existing row', async () => {
    const f = build();
    f.manager.query.mockResolvedValue([{ id: 'usage-1' }]); // UPDATE hit a row

    await f.turn();

    const usageWrites = f.manager.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('ai_usage_logs'),
    );
    expect(usageWrites).toHaveLength(1);
    expect(usageWrites[0][0]).toContain('UPDATE ai_usage_logs');
  });

  it('keeps the race-safe atomic upsert for an agent-bound turn (unchanged)', async () => {
    const f = build({ agent: { id: 'agent-1' } });

    await f.turn();

    const usageWrites = f.manager.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('ai_usage_logs'),
    );
    expect(usageWrites).toHaveLength(1);
    expect(usageWrites[0][0]).toContain('ON CONFLICT');
    expect(usageWrites[0][1]).toContain('agent-1');
  });
});

// ───────────────────── Tool routing vs. knowledge answering ─────────────────

describe('Tool routing — a tool result never displaces the Knowledge', () => {
  it('keeps <knowledge> in context after an empty list_cities result comes back', async () => {
    // Reproduces the reported turn exactly: the model reaches for list_cities on
    // a clinic-information question and the tool returns zero cities. What used
    // to make that answer wrong was that there was no <knowledge> to fall back
    // on. Now the block is present on the follow-up iteration too, so the model
    // can still answer from it.
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
      chunks: [
        {
          id: 'kb-1',
          content: 'عيادة النور: من السبت إلى الخميس 9ص–10م.',
          score: 0.9,
        },
      ],
      script: [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: AI_PUBLIC_TOOL.LIST_CITIES, arguments: '{}' },
          ],
        },
        { content: 'من السبت إلى الخميس، 9 صباحًا حتى 10 مساءً.' },
      ],
      toolResult: { success: true, cities: [] },
    });

    const result = await f.turn();

    expect(f.dispatch.execute).toHaveBeenCalledTimes(1);
    expect(result.lastTool).toMatchObject({
      name: AI_PUBLIC_TOOL.LIST_CITIES,
      result: { cities: [] },
    });
    // The second provider call — the one that produces the final answer — still
    // carries both the instructions and the knowledge.
    expect(f.knowledgeMessage(1)).toContain('عيادة النور');
    expect(f.systemMessage(1)).toBe(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT);
  });

  it('the list_cities description no longer orders an unconditional first call', () => {
    const listCities = AI_PUBLIC_BOOKING_TOOLS.find(
      (t) => t.name === AI_PUBLIC_TOOL.LIST_CITIES,
    );
    expect(listCities).toBeDefined();
    const description = listCities!.description;

    // The old text — "Call this FIRST, when the visitor has not said where they
    // are" — read as an unconditional opener and is what pulled an
    // informational question into the booking flow.
    expect(description).not.toMatch(/Call this FIRST/);
    // It is now explicitly scoped to a booking, and explicitly deferred to
    // <knowledge> for anything informational.
    expect(description).toMatch(/only when the visitor wants to book/i);
    expect(description).toMatch(/<knowledge>/);
    // And it must not be called again once the context already holds a city or
    // clinic — the repeat call is what restarted discovery every turn.
    expect(description).toMatch(/ESTABLISHED BOOKING CONTEXT/);
  });

  it('the list_cities description forbids reading an empty city list as "no clinics"', () => {
    // The reported failure in one sentence: `cities: []` was reported to the
    // visitor as "there are no clinics available for booking", a claim the tool
    // cannot support because `branches.city_id` is nullable — a bookable clinic
    // that never recorded a city contributes no city here.
    const description = AI_PUBLIC_BOOKING_TOOLS.find(
      (t) => t.name === AI_PUBLIC_TOOL.LIST_CITIES,
    )!.description;

    expect(description).toMatch(/EMPTY `cities` LIST DOES NOT MEAN/i);
    expect(description).toMatch(/bookableClinics/);
    // And it must name the recovery, not just forbid the mistake.
    expect(description).toMatch(/search_clinics with no arguments/i);
  });

  it('search_clinics takes a cityId, so a chosen city is a filter and not a dead end', () => {
    // `PublicDiscoveryService.searchClinics` has always accepted a city (the
    // REST endpoint passes one), but the TOOL schema exposed only `query`,
    // which matches clinic/slug/service names. So after "which city?" the model
    // had nowhere to put the answer except `query`, where a city name matches
    // nothing — and an empty result became "no clinics available".
    const searchClinics = AI_TOOLS.find(
      (t) => t.name === AI_TOOL.SEARCH_CLINICS,
    )!;

    expect(searchClinics.parameters.properties).toHaveProperty('cityId');
    expect(searchClinics.description).toMatch(
      /NEVER put a city name in `query`/,
    );
    // Calling it bare is the documented answer to "whatever you have".
    expect(searchClinics.description).toMatch(/NO arguments/);
  });

  it('still advertises the full booking toolset to a visitor, unchanged', async () => {
    const f = build({ tenantId: DISCOVERY_TENANT, guest: true });

    await f.turn();

    // Business logic and tool surface are untouched by this fix — only the
    // wording of one description changed.
    for (const tool of Object.values(AI_PUBLIC_TOOL)) {
      expect(f.toolNames()).toContain(tool);
    }
  });

  it('a real booking turn still dispatches its booking tool call normally', async () => {
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub' },
      script: [
        {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: AI_PUBLIC_TOOL.SELECT_CLINIC,
              arguments: JSON.stringify({ clinicId: CLINIC_TENANT }),
            },
          ],
        },
        { content: 'Which branch would you like?' },
      ],
      toolResult: { success: true, branchAutoSelected: true },
    });

    const result = await f.turn();

    expect(f.dispatch.execute).toHaveBeenCalledTimes(1);
    expect(f.dispatch.execute.mock.calls[0][1]).toMatchObject({
      name: AI_PUBLIC_TOOL.SELECT_CLINIC,
    });
    expect(result.lastTool?.name).toBe(AI_PUBLIC_TOOL.SELECT_CLINIC);
    expect(result.message.content).toBe('Which branch would you like?');
  });
});

// ─────────────────── Model / agent selection stays Admin-owned ──────────────

describe('Model and agent selection remain platform-controlled', () => {
  it('takes the model from the server-side router, never from the request', async () => {
    const f = build();

    await f.turn();

    expect(f.provider.complete.mock.calls[0][0].model).toBe('gpt-4o');
    // `SendMessageDto` carries content + idempotencyKey and nothing else, so
    // there is no field a client could use to nominate a model.
    expect(Object.keys(new SendMessageDto())).not.toContain('model');
  });

  it('exposes no model field on the client-facing turn DTO', () => {
    const dtoSource = readFileSync(
      path.resolve(__dirname, 'dto/send-message.dto.ts'),
      'utf8',
    );
    expect(dtoSource).not.toMatch(/\bmodel\s*[?!]?\s*:/);
    expect(dtoSource).not.toMatch(/\btemperature\s*[?!]?\s*:/);
  });

  // ─────────────── Booking context survives across turns ──────────────────

  it('pins the server-verified booking context into a public turn', async () => {
    // THE REGRESSION. Only USER and ASSISTANT rows are persisted to
    // `ai_messages` and only those are replayed as history, so a tool result
    // that established a clinic vanished the moment the turn ended. The ids
    // were on `ai_conversations.session` the whole time — nothing ever put them
    // in the prompt, so the model restarted discovery from `list_cities`.
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
      bookingContext:
        'ESTABLISHED BOOKING CONTEXT (server-verified against the database this turn).\n- clinic: Al Noor Medical (id clinic-a-tenant)',
    });

    await f.turn();

    const systems = f.systemMessages(0);
    expect(systems[0]).toBe(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT);
    expect(systems[1]).toContain('ESTABLISHED BOOKING CONTEXT');
    expect(systems[1]).toContain('clinic-a-tenant');
  });

  it('does not build a booking context for an authenticated staff turn', async () => {
    // The block is public-surface state. A staff turn has no anonymous booking
    // session, and asking for one would be a pointless query on every turn.
    const f = build({ session: { selectedClinicId: CLINIC_TENANT } });

    await f.turn();

    expect(f.describeSelection).not.toHaveBeenCalled();
    expect(f.systemMessages(0)).toHaveLength(1);
  });

  it('refreshes the pinned context after a select_* runs inside the tool loop', async () => {
    // "Do not let the tool result erase the established clinic information."
    // A `select_branch` landing mid-loop moves the server-side selection on; if
    // the pinned block still described the previous state, the model would be
    // reading two contradictory accounts of the same booking.
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
      bookingContexts: [
        'ESTABLISHED BOOKING CONTEXT\n- clinic: Al Noor Medical (id clinic-a-tenant)',
        'ESTABLISHED BOOKING CONTEXT\n- clinic: Al Noor Medical (id clinic-a-tenant)\n- branch: Olaya (id branch-1)',
      ],
      script: [
        {
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: AI_PUBLIC_TOOL.SELECT_BRANCH,
              arguments: '{"branchId":"branch-1"}',
            },
          ],
        },
        { content: 'تم اختيار فرع العليا.' },
      ],
      toolResult: { success: true, branchId: 'branch-1' },
    });

    await f.turn();

    // Iteration 0 saw the pre-selection block; iteration 1 — the one that
    // composes the reply — sees the branch that was just recorded.
    expect(f.systemMessages(0)[1]).not.toContain('branch-1');
    expect(f.systemMessages(1)[1]).toContain('branch-1');
  });

  it('leaves the pinned context alone for a tool that does not change the selection', async () => {
    // A read-only lookup must not cost a rebuild — the refresh is keyed on the
    // tools that actually write the selection.
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub', selectedClinicId: CLINIC_TENANT },
      eligibleClinics: [CLINIC_TENANT],
      bookingContext: 'ESTABLISHED BOOKING CONTEXT\n- clinic: Al Noor Medical',
      script: [
        {
          content: '',
          toolCalls: [
            { id: 'c1', name: AI_PUBLIC_TOOL.LIST_CITIES, arguments: '{}' },
          ],
        },
        { content: 'ok' },
      ],
      toolResult: { success: true, cities: [], bookableClinics: 3 },
    });

    await f.turn();

    // One build for the prompt, and no rebuild for the read-only call.
    expect(f.describeSelection).toHaveBeenCalledTimes(1);
    expect(f.systemMessages(1)[1]).toContain('Al Noor Medical');
  });

  it('answers a turn normally when the booking context cannot be produced', async () => {
    // Degrades to "no block", never to "no reply": a context lookup failure
    // must not cost the visitor their answer.
    const f = build({
      tenantId: DISCOVERY_TENANT,
      guest: true,
      session: { guestSubject: 'guest-sub' },
    });
    f.describeSelection.mockRejectedValue(new Error('db down'));

    await expect(f.turn()).resolves.toBeDefined();
    expect(f.systemMessages(0)).toHaveLength(1);
  });

  it('keeps selectedCityId out of the client-patchable session keys', () => {
    // The city is server-write-only for the same reason every other `selected*`
    // key is: it steers which clinics a visitor is shown, and the booking
    // tenant is derived from that chain.
    expect(SESSION_CLIENT_PATCHABLE_KEYS).not.toContain('selectedCityId');
  });

  it('never creates an agent as a side effect of a turn', async () => {
    const f = build();

    await f.turn();

    // The only writes a turn makes are messages and usage/cost rows.
    const agentWrites = f.manager.query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('ai_agents'),
    );
    expect(agentWrites).toHaveLength(0);
    expect(f.rag.retrieve.mock.calls[0][1]).toBeNull();
  });
});
