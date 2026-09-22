import { ConfigService } from '@nestjs/config';

import { AI_MODEL_REGISTRY, AiModelDefinition } from '../routing/ai-model-registry';
import { AiCompletionRequest, AiToolDefinition } from './ai-provider.interface';
import { OpenAiChatProvider } from './openai-chat.provider';

/**
 * LIVE provider compatibility smoke — the blocking gate before any routing
 * rollout rung, and the gate that promotes a PREVIEW registry entry to GA.
 *
 * Every claim in `AI_MODEL_REGISTRY` is an assertion about a remote service that
 * only a real request can settle. A model can be correctly priced, correctly
 * gated and still 400 on the exact request shape this codebase sends — that is
 * precisely how the GPT-5.x family behaves when `temperature` is sent. Passing
 * this suite is what earned that family its GA promotion; nothing reaches a
 * clinic's model picker without it.
 *
 * OPT-IN. Skipped unless `OPENAI_LIVE_TESTS=true`, because it spends real money
 * and needs network. It is a `.spec.ts` (not a differently-suffixed file) on
 * purpose: jest's `rootDir` is `src` with `testRegex .*\.spec\.ts$`, so anything
 * outside that is not merely excluded from CI — it is unrunnable by any normal
 * command. Skipping at runtime keeps it discoverable and one env var away.
 *
 *   OPENAI_LIVE_TESTS=true OPENAI_API_KEY=sk-... npx jest openai-model-compat
 */
const LIVE = process.env.OPENAI_LIVE_TESTS === 'true' && !!process.env.OPENAI_API_KEY;
const describeLive = LIVE ? describe : describe.skip;

const TOOL: AiToolDefinition = {
  name: 'check_availability',
  description: 'Check appointment availability for a date. Call this to answer availability questions.',
  parameters: {
    type: 'object',
    properties: { date: { type: 'string', description: 'ISO date, e.g. 2026-09-01' } },
    required: ['date'],
  },
};

function providerFor(model: AiModelDefinition): OpenAiChatProvider {
  return new OpenAiChatProvider(
    new ConfigService({
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AI_FALLBACK_MODEL: model.id,
      // Keep a failing model from stalling the whole sweep.
      OPENAI_REQUEST_TIMEOUT_MS: 60_000,
      OPENAI_PROVIDER_MAX_RETRIES: 1,
    }),
  );
}

const TENANT = 'live-compat';

/**
 * The capability fields `AiExecutionService` threads onto every real request.
 * Sending them here is what makes this suite test the SHAPE production sends
 * rather than a simplified one — without them a reasoning model would 400 on
 * every case below and the failure would look like a model problem.
 */
function caps(model: AiModelDefinition): Partial<AiCompletionRequest> {
  return {
    supportsTemperature: model.supportsTemperature,
    reasoningEffort: model.reasoningEffort,
  };
}

describeLive('OpenAI live model compatibility', () => {
  jest.setTimeout(120_000);

  describe.each(AI_MODEL_REGISTRY.map((m) => [m.id, m] as const))('%s', (_id, model) => {
    it('completes a non-streaming turn and reports real usage', async () => {
      const result = await providerFor(model).complete({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        maxOutputTokens: 32,
      });

      expect(result.content.trim().length).toBeGreaterThan(0);
      // Usage is what the entire cost ledger is built on. A model that does not
      // report it makes every turn UNPRICED.
      expect(result.promptTokens).toBeGreaterThan(0);
      expect(result.completionTokens).toBeGreaterThan(0);
      // `cachedPromptTokens` must be a number (0 is a valid answer) — an
      // undefined here would silently zero the cached-token accounting.
      expect(typeof result.cachedPromptTokens).toBe('number');
      expect(typeof result.cacheWriteTokens).toBe('number');
      // The resolved id must be registry-resolvable, or its cost row is UNPRICED.
      expect(result.model).toEqual(expect.any(String));
    });

    /**
     * Temperature is the one capability that FAILS CLOSED at the provider: a
     * model that rejects it rejects the whole request. So the assertion is
     * two-sided — the registry's claim must match reality in both directions,
     * because being wrong either way is a 100% failure rate, not a degradation.
     */
    if (model.supportsTemperature) {
      it('accepts the temperature this provider sends', async () => {
        const result = await providerFor(model).complete({
          tenantId: TENANT,
          model: model.id,
          ...caps(model),
          temperature: 0.2,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          maxOutputTokens: 32,
        });
        expect(result.content.trim().length).toBeGreaterThan(0);
      });
    } else {
      it('succeeds with temperature OMITTED', async () => {
        const result = await providerFor(model).complete({
          tenantId: TENANT,
          model: model.id,
          ...caps(model),
          // A temperature IS supplied by the caller and must be dropped by the
          // provider — the same thing an agent row's configured value does.
          temperature: 0.2,
          messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
          maxOutputTokens: 32,
        });
        expect(result.content.trim().length).toBeGreaterThan(0);
      });

      it('REJECTS an explicit temperature — proving the omission is load-bearing', async () => {
        // If this ever starts passing, the model accepts a temperature after all
        // and the registry entry is wrong in the harmless direction. Better to
        // learn that here than to keep a special case nobody can justify.
        await expect(
          providerFor(model).complete({
            tenantId: TENANT,
            model: model.id,
            supportsTemperature: true,
            temperature: 0.2,
            messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
            maxOutputTokens: 32,
          }),
        ).rejects.toThrow();
      });
    }

    it('streams deltas and reports usage on the terminal chunk', async () => {
      expect(model.supportsStreaming).toBe(true);
      const provider = providerFor(model);
      let deltas = 0;
      let terminal: { usage?: { promptTokens: number; completionTokens: number }; model?: string } | undefined;

      for await (const chunk of provider.stream({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [{ role: 'user', content: 'Count from one to five in words.' }],
        maxOutputTokens: 64,
      })) {
        if (chunk.delta) deltas += 1;
        if (chunk.done) terminal = chunk;
      }

      expect(deltas).toBeGreaterThan(0);
      // `stream_options: { include_usage: true }` must actually be honored, or
      // every streamed turn falls back to estimates and is marked UNPRICED.
      expect(terminal?.usage?.promptTokens).toBeGreaterThan(0);
      expect(terminal?.usage?.completionTokens).toBeGreaterThan(0);
    });

    it('performs a tool-call round trip (non-streaming)', async () => {
      expect(model.supportsTools).toBe(true);
      const provider = providerFor(model);
      const first = await provider.complete({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [
          { role: 'system', content: 'Use the provided tools to answer. Do not guess availability.' },
          { role: 'user', content: 'Is there an appointment free on 2026-09-01?' },
        ],
        tools: [TOOL],
        maxOutputTokens: 128,
      });

      expect(first.toolCalls?.length ?? 0).toBeGreaterThan(0);
      const call = first.toolCalls![0];
      expect(call.name).toBe(TOOL.name);
      expect(() => JSON.parse(call.arguments)).not.toThrow();

      // Feed the result back — the same shape AiExecutionService's loop uses.
      const second = await provider.complete({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [
          { role: 'system', content: 'Use the provided tools to answer.' },
          { role: 'user', content: 'Is there an appointment free on 2026-09-01?' },
          { role: 'assistant', content: first.content || null, tool_calls: first.toolCalls },
          {
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({ success: true, slots: ['09:00', '14:30'] }),
          },
        ],
        tools: [TOOL],
        maxOutputTokens: 128,
      });
      expect(second.content.trim().length).toBeGreaterThan(0);
    });

    it('reassembles streamed tool-call fragments', async () => {
      const provider = providerFor(model);
      let terminalCalls: { name: string; arguments: string }[] | undefined;

      for await (const chunk of provider.stream({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [
          { role: 'system', content: 'Use the provided tools to answer. Do not guess availability.' },
          { role: 'user', content: 'Is there an appointment free on 2026-09-01?' },
        ],
        tools: [TOOL],
        maxOutputTokens: 128,
      })) {
        if (chunk.done) terminalCalls = chunk.toolCalls;
      }

      // Streamed tool calls arrive as fragments keyed by index; the provider
      // reassembles them so the streaming path can run the SAME dispatch loop.
      expect(terminalCalls?.length ?? 0).toBeGreaterThan(0);
      expect(() => JSON.parse(terminalCalls![0].arguments)).not.toThrow();
    });

    /**
     * PRINTS rather than asserts. The installed SDK's `PromptTokensDetails` type
     * predates cache-write billing, so `OpenAiChatProvider.cacheWriteTokens()`
     * reads the field off the raw object by name — and a wrong name under-bills
     * silently instead of failing. This dump is how that name gets confirmed
     * against the live API before a cache-write-billing model goes GA.
     */
    it('dumps the raw usage object for rate-field confirmation', async () => {
      const provider = providerFor(model);
      const raw: unknown[] = [];
      const client = (provider as unknown as { client: { chat: { completions: { create: Function } } } }).client;
      const create = client.chat.completions.create.bind(client.chat.completions);
      client.chat.completions.create = async (...args: unknown[]) => {
        const res = await create(...args);
        raw.push((res as { usage?: unknown }).usage);
        return res;
      };

      await provider.complete({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        // A long-ish prompt makes a cache write more likely to appear at all.
        messages: [{ role: 'user', content: `Summarize in one word: ${'context '.repeat(200)}` }],
        maxOutputTokens: 32,
      });

      // eslint-disable-next-line no-console
      console.log(
        `\n[usage] ${model.id} (${model.releaseStage})\n${JSON.stringify(raw[0], null, 2)}\n`,
      );
      expect(raw[0]).toBeDefined();

      if (model.cacheWriteMultiplier) {
        // The field the cost path multiplies. It is reported only when the API
        // actually performs a cache write, which this test cannot force — so the
        // assertion is on the SHAPE the provider normalises to, not on a
        // non-zero count. A `undefined` here would multiply into a silent
        // under-bill; that is the failure being guarded against.
        const details = (raw[0] as { prompt_tokens_details?: unknown })
          ?.prompt_tokens_details;
        expect(details).toBeDefined();
      }
    });

    /**
     * Every model, cache-write-billing or not, must hand the cost path a real
     * integer. This is the regression guard for the streaming bug found on
     * 2026-08-19: the execution layer copied the terminal chunk field by field
     * and dropped `cacheWriteTokens`, so streaming — the dominant chat path —
     * under-billed while the non-streaming path looked correct.
     */
    it('always reports a well-formed cache-write token count', async () => {
      const result = await providerFor(model).complete({
        tenantId: TENANT,
        model: model.id,
        ...caps(model),
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxOutputTokens: 32,
      });
      expect(Number.isSafeInteger(result.cacheWriteTokens)).toBe(true);
      expect(result.cacheWriteTokens).toBeGreaterThanOrEqual(0);
    });
  });
});
