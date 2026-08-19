import { ConfigService } from '@nestjs/config';

import { AiPriceCatalogService } from '../cost/ai-price-catalog.service';
import { AiToolDefinition } from '../providers/ai-provider.interface';
import { OpenAiChatProvider } from '../providers/openai-chat.provider';
import { findModel } from '../routing/ai-model-registry';
import {
  AI_EVALUATION_CASES,
  AiEvaluationCase,
  repliesInSameLanguage,
} from './ai-evaluation.fixtures';

/**
 * LIVE Arabic/English benchmark — the gate `docs/AI_FINOPS_HARDENING.md` has
 * been waiting on since the FinOps work ("pending account credits"), and the
 * exit criterion for rung 1 of the model-routing rollout.
 *
 * WHAT IT ASSERTS vs WHAT IT REPORTS — the distinction is the point:
 *
 *  - ASSERTS capability PARITY, mechanically: the candidate answers in the
 *    language it was asked in, and reaches for a tool when the incumbent does.
 *    Those are checkable without judging prose, so they can fail a build.
 *  - REPORTS answer text, latency and cost side by side for a HUMAN to read.
 *    It deliberately does not score semantic quality with another model. A model
 *    grading a model would inherit exactly the failure mode this exists to
 *    catch, and "the rollout was approved because GPT said the answers were
 *    fine" is not an approval anyone should be able to point at later.
 *
 * OPT-IN — spends real money on both models:
 *
 *   OPENAI_LIVE_TESTS=true OPENAI_API_KEY=sk-... \
 *   AI_BENCHMARK_BASELINE=gpt-4o AI_BENCHMARK_CANDIDATE=gpt-4.1-mini \
 *   npx jest ai-evaluation.live
 */
const LIVE = process.env.OPENAI_LIVE_TESTS === 'true' && !!process.env.OPENAI_API_KEY;
const describeLive = LIVE ? describe : describe.skip;

const BASELINE = process.env.AI_BENCHMARK_BASELINE ?? 'gpt-4o';
const CANDIDATE = process.env.AI_BENCHMARK_CANDIDATE ?? 'gpt-4.1-mini';

const SYSTEM_PROMPT =
  'You are a clinic receptionist assistant. Answer in the SAME language the customer writes in. ' +
  'Use the provided tools for anything involving appointment availability or booking; never invent a time slot.';

const TOOLS: AiToolDefinition[] = [
  {
    name: 'check_availability',
    description: 'Check appointment availability. Call this before offering any time slot.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date' },
        specialty: { type: 'string' },
      },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book a specific appointment slot for the customer.',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string' }, time: { type: 'string' } },
      required: ['date', 'time'],
    },
  },
];

interface CaseResult {
  model: string;
  caseId: string;
  reply: string;
  sameLanguage: boolean;
  toolCalled: boolean;
  promptTokens: number;
  completionTokens: number;
  costMicrousd: bigint | null;
  latencyMs: number;
}

function provider(model: string): OpenAiChatProvider {
  return new OpenAiChatProvider(
    new ConfigService({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_CHAT_MODEL: model,
      OPENAI_REQUEST_TIMEOUT_MS: 60_000,
      OPENAI_PROVIDER_MAX_RETRIES: 1,
    }),
  );
}

const prices = new AiPriceCatalogService(new ConfigService());

/**
 * Canned, language-neutral tool results. Data only — no prose — so feeding them
 * back cannot itself hint at which language the model should answer in.
 */
function toolResult(name: string): string {
  return name === 'book_appointment'
    ? JSON.stringify({ success: true, confirmation_id: 'BK-10024', date: '2026-09-01', time: '17:00' })
    : JSON.stringify({ success: true, date: '2026-09-01', slots: ['09:00', '14:30', '17:00'] });
}

/** Mirrors AiExecutionService's own cap — a runaway loop is a bug, not a result. */
const MAX_LOOPS = 3;

/**
 * Runs one fixture against one model, INCLUDING the tool round trip.
 *
 * The loop is not incidental. A booking turn's correct first response is a tool
 * call with no prose, so a single-shot harness records `reply: ''` and scores it
 * as an empty answer and a language failure — punishing the model for behaving
 * correctly. `AiExecutionService` feeds the tool result back and the customer
 * sees the FINAL sentence; that is what this measures. Tokens, cost and latency
 * accumulate across every hop, because that is what the turn actually costs.
 */
async function runCase(model: string, fixture: AiEvaluationCase): Promise<CaseResult> {
  const started = Date.now();
  const p = provider(model);
  const definition = findModel(model);
  const messages: Parameters<typeof p.complete>[0]['messages'] = [
    { role: 'system', content: SYSTEM_PROMPT },
    // Every turn as one exchange: this measures the model's handling of the
    // accumulated conversation, which is what a real turn sees.
    ...fixture.turns.map((content) => ({ role: 'user' as const, content })),
  ];

  let reply = '';
  let toolCalled = false;
  let promptTokens = 0;
  let completionTokens = 0;
  let costMicrousd: bigint | null = 0n;

  for (let loop = 0; loop < MAX_LOOPS; loop += 1) {
    const result = await p.complete({
      tenantId: 'benchmark',
      model,
      temperature: 0.2,
      // Same capability threading production uses — without it a reasoning
      // model 400s and the benchmark measures nothing.
      supportsTemperature: definition?.supportsTemperature,
      reasoningEffort: definition?.reasoningEffort,
      messages,
      tools: TOOLS,
      maxOutputTokens: 400,
    });

    promptTokens += result.promptTokens;
    completionTokens += result.completionTokens;
    const quote = prices.quoteChat(
      'openai',
      result.model,
      result.promptTokens,
      result.completionTokens,
      result.cachedPromptTokens ?? 0,
      undefined,
      undefined,
      result.cacheWriteTokens ?? 0,
    );
    // One UNPRICED hop makes the whole turn's cost unknown — never partially
    // summed, which would understate it.
    costMicrousd =
      costMicrousd === null || quote.costMicrousd === null
        ? null
        : costMicrousd + quote.costMicrousd;

    reply = result.content || reply;
    const calls = result.toolCalls ?? [];
    if (!calls.length) break;
    toolCalled = true;

    messages.push({ role: 'assistant', content: result.content || null, tool_calls: calls });
    for (const call of calls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: toolResult(call.name),
      });
    }
  }

  return {
    model,
    caseId: fixture.id,
    reply,
    sameLanguage: repliesInSameLanguage(fixture.language, reply),
    toolCalled,
    promptTokens,
    completionTokens,
    costMicrousd,
    latencyMs: Date.now() - started,
  };
}

describeLive(`AR/EN quality benchmark — ${CANDIDATE} vs ${BASELINE}`, () => {
  jest.setTimeout(600_000);

  const results = new Map<string, { baseline: CaseResult; candidate: CaseResult }>();

  beforeAll(async () => {
    for (const fixture of AI_EVALUATION_CASES) {
      // Sequential on purpose: parallel runs distort the latency column, which
      // is one of the two numbers a human is being asked to judge.
      const baseline = await runCase(BASELINE, fixture);
      const candidate = await runCase(CANDIDATE, fixture);
      results.set(fixture.id, { baseline, candidate });
    }
  });

  it('both models are registered and priceable — otherwise the comparison is meaningless', () => {
    for (const id of [BASELINE, CANDIDATE]) {
      expect(findModel(id)).toBeDefined();
      expect(prices.quoteChat('openai', id, 1_000, 1_000).status).toBe('PRICED');
    }
  });

  it.each(AI_EVALUATION_CASES)(
    '$id — candidate answers in the same language as the customer',
    (fixture) => {
      const { candidate } = results.get(fixture.id)!;
      expect(candidate.reply.trim().length).toBeGreaterThan(0);
      if (fixture.expect.repliesInSameLanguage) {
        expect(candidate.sameLanguage).toBe(true);
      }
    },
  );

  it.each(AI_EVALUATION_CASES.filter((c) => c.expect.emitsToolCall))(
    '$id — candidate reaches for a tool rather than inventing an answer',
    (fixture) => {
      const { candidate } = results.get(fixture.id)!;
      expect(candidate.toolCalled).toBe(true);
    },
  );

  it('candidate does not regress tool-calling relative to the baseline on any case', () => {
    const regressions = AI_EVALUATION_CASES.filter((f) => {
      const { baseline, candidate } = results.get(f.id)!;
      return baseline.toolCalled && !candidate.toolCalled;
    }).map((f) => f.id);
    expect(regressions).toEqual([]);
  });

  it('candidate does not regress language fidelity relative to the baseline', () => {
    const regressions = AI_EVALUATION_CASES.filter((f) => {
      const { baseline, candidate } = results.get(f.id)!;
      return baseline.sameLanguage && !candidate.sameLanguage;
    }).map((f) => f.id);
    expect(regressions).toEqual([]);
  });

  /**
   * Not an assertion — the human-readable half. Printed so whoever approves the
   * rollout reads the actual Arabic and English answers, side by side, with what
   * each cost. Reviewing this output IS the gate; the assertions above only
   * prove nothing mechanically broke.
   */
  it('prints the side-by-side comparison for human approval', () => {
    const usd = (v: bigint | null) => (v === null ? 'UNPRICED' : `$${(Number(v) / 1e6).toFixed(6)}`);
    let baseTotal = 0n;
    let candTotal = 0n;

    for (const fixture of AI_EVALUATION_CASES) {
      const { baseline, candidate } = results.get(fixture.id)!;
      baseTotal += baseline.costMicrousd ?? 0n;
      candTotal += candidate.costMicrousd ?? 0n;

      // eslint-disable-next-line no-console
      console.log(
        `\n──── ${fixture.id} (${fixture.language}/${fixture.capability}) ────\n` +
          `PROMPT: ${fixture.turns.join(' | ')}\n\n` +
          `[${BASELINE}] lang=${baseline.sameLanguage} tool=${baseline.toolCalled} ` +
          `${baseline.latencyMs}ms ${usd(baseline.costMicrousd)}\n${baseline.reply}\n\n` +
          `[${CANDIDATE}] lang=${candidate.sameLanguage} tool=${candidate.toolCalled} ` +
          `${candidate.latencyMs}ms ${usd(candidate.costMicrousd)}\n${candidate.reply}\n`,
      );
    }

    const delta = baseTotal === 0n ? 0 : Number(candTotal - baseTotal) / Number(baseTotal);
    // eslint-disable-next-line no-console
    console.log(
      `\n════ TOTAL over ${AI_EVALUATION_CASES.length} cases ════\n` +
        `${BASELINE}:  ${usd(baseTotal)}\n${CANDIDATE}: ${usd(candTotal)}\n` +
        `change: ${(delta * 100).toFixed(1)}%\n` +
        `Read the replies above before approving a rollout rung.\n`,
    );

    expect(results.size).toBe(AI_EVALUATION_CASES.length);
  });
});
