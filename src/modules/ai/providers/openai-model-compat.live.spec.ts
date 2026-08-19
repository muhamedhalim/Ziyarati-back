import { ConfigService } from '@nestjs/config';

import { AI_MODEL_REGISTRY, AiModelDefinition } from '../routing/ai-model-registry';
import { AiToolDefinition } from './ai-provider.interface';
import { OpenAiChatProvider } from './openai-chat.provider';

/**
 * LIVE provider compatibility smoke — the blocking gate before any routing
 * rollout rung.
 *
 * Every claim in `AI_MODEL_REGISTRY` is an assertion about a remote service that
 * only a real request can settle. A model can be correctly priced, correctly
 * gated and still 400 on the exact request shape this codebase sends — that is
 * precisely how the GPT-5 family behaves today, because
 * `OpenAiChatProvider.requestBody()` always sends `temperature`.
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
      OPENAI_CHAT_MODEL: model.id,
      // Keep a failing model from stalling the whole sweep.
      OPENAI_REQUEST_TIMEOUT_MS: 60_000,
      OPENAI_PROVIDER_MAX_RETRIES: 1,
    }),
  );
}

const TENANT = 'live-compat';

describeLive('OpenAI live model compatibility', () => {
  jest.setTimeout(120_000);

  describe.each(AI_MODEL_REGISTRY.map((m) => [m.id, m] as const))('%s', (_id, model) => {
    it('completes a non-streaming turn and reports real usage', async () => {
      const result = await providerFor(model).complete({
        tenantId: TENANT,
        model: model.id,
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
      // The resolved id must be registry-resolvable, or its cost row is UNPRICED.
      expect(result.model).toEqual(expect.any(String));
    });

    it('accepts the temperature this provider always sends', async () => {
      // The GPT-5 family rejects any non-default temperature. This is the
      // assertion that must fail loudly before such a model is registered
      // without the Phase 7 provider change.
      expect(model.supportsTemperature).toBe(true);
      const result = await providerFor(model).complete({
        tenantId: TENANT,
        model: model.id,
        temperature: 0.2,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxOutputTokens: 32,
      });
      expect(result.content.trim().length).toBeGreaterThan(0);
    });

    it('streams deltas and reports usage on the terminal chunk', async () => {
      expect(model.supportsStreaming).toBe(true);
      const provider = providerFor(model);
      let deltas = 0;
      let terminal: { usage?: { promptTokens: number; completionTokens: number }; model?: string } | undefined;

      for await (const chunk of provider.stream({
        tenantId: TENANT,
        model: model.id,
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
  });
});
