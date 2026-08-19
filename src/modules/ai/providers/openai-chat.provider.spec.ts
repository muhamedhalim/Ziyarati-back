import { ConfigService } from '@nestjs/config';
import { OpenAiChatProvider } from './openai-chat.provider';

describe('OpenAiChatProvider (mocked SDK)', () => {
  it('sets an explicit timeout, disables SDK retries, caps output, and captures cached tokens', async () => {
    const provider = new OpenAiChatProvider(new ConfigService({
      OPENAI_API_KEY: 'test-key-not-used', OPENAI_REQUEST_TIMEOUT_MS: 4321,
      OPENAI_PROVIDER_MAX_RETRIES: 0,
    }));
    expect((provider as any).client.timeout).toBe(4321);
    expect((provider as any).client.maxRetries).toBe(0);
    const create = jest.fn().mockResolvedValue({
      _request_id: 'req-1', model: 'gpt-4o-2024-08-06',
      choices: [{ message: { content: 'مرحبا', tool_calls: [] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    });
    (provider as any).client = { chat: { completions: { create } } };
    const abort = new AbortController();
    const result = await provider.complete({
      tenantId: 't1', model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 77, idempotencyKey: 'idem-12345678', signal: abort.signal,
    });
    expect(create.mock.calls[0][0].max_completion_tokens).toBe(77);
    expect(create.mock.calls[0][1].headers['Idempotency-Key']).toBe('idem-12345678');
    expect(create.mock.calls[0][1].signal).toBe(abort.signal);
    expect(result).toEqual(expect.objectContaining({
      promptTokens: 100, completionTokens: 20, cachedPromptTokens: 40,
      providerAttempts: 1, providerRequestId: 'req-1',
    }));
  });

  it('dials the tenant REGIONAL client when Data Residency is enforced (standard chat)', async () => {
    const globalCreate = jest.fn();
    const tenantCreate = jest.fn().mockResolvedValue({
      model: 'gpt-4o', choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const clients = { forTenant: jest.fn().mockResolvedValue({ chat: { completions: { create: tenantCreate } } }) };
    const provider = new OpenAiChatProvider(new ConfigService({ OPENAI_API_KEY: 'k' }), clients as any);
    (provider as any).client = { chat: { completions: { create: globalCreate } } };
    await provider.complete({ tenantId: 't-eu', messages: [{ role: 'user', content: 'hi' }] });
    expect(clients.forTenant).toHaveBeenCalledWith('t-eu');
    expect(tenantCreate).toHaveBeenCalledTimes(1);
    expect(globalCreate).not.toHaveBeenCalled();
  });

  it('propagates a fail-closed residency error (never falls back to the global client)', async () => {
    const globalCreate = jest.fn();
    const clients = { forTenant: jest.fn().mockRejectedValue(new Error('residency required')) };
    const provider = new OpenAiChatProvider(new ConfigService({ OPENAI_API_KEY: 'k' }), clients as any);
    (provider as any).client = { chat: { completions: { create: globalCreate } } };
    await expect(provider.complete({ tenantId: 't-eu', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/residency/i);
    expect(globalCreate).not.toHaveBeenCalled();
  });
});

/**
 * Model capabilities travel with the request. The GPT-5.x family accepts ONLY
 * the default temperature and returns 400 for any explicit value — and this
 * provider unconditionally sent `temperature: request.temperature ?? 0.2`. So
 * this is not a tuning nicety: without it, routing to a reasoning model fails
 * 100% of requests, on the first one, in production.
 */
describe('OpenAiChatProvider — model capability handling', () => {
  function harness(response: Record<string, unknown> = {}) {
    const provider = new OpenAiChatProvider(
      new ConfigService({ OPENAI_API_KEY: 'k' }),
    );
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.6-luna',
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      ...response,
    });
    (provider as any).client = { chat: { completions: { create } } };
    return { provider, create, body: () => create.mock.calls[0][0] };
  }

  it('sends temperature for a model that supports one (unchanged behaviour)', async () => {
    const { provider, body } = harness();
    await provider.complete({
      tenantId: 't1', model: 'gpt-4o', temperature: 0.7,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body().temperature).toBe(0.7);
  });

  it('defaults temperature to 0.2 when the caller omits it', async () => {
    const { provider, body } = harness();
    await provider.complete({
      tenantId: 't1', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body().temperature).toBe(0.2);
  });

  it('OMITS temperature entirely for a model that does not support one', async () => {
    const { provider, body } = harness();
    await provider.complete({
      tenantId: 't1', model: 'gpt-5.6-luna',
      // The agent row still carries a temperature; it must be dropped, not sent.
      temperature: 0.7, supportsTemperature: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Absent, not null and not 1 — an explicit value of ANY kind is a 400.
    expect(body()).not.toHaveProperty('temperature');
  });

  it('sends reasoning_effort only when the registry names one', async () => {
    const withEffort = harness();
    await withEffort.provider.complete({
      tenantId: 't1', model: 'gpt-5.6-luna',
      supportsTemperature: false, reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(withEffort.body().reasoning_effort).toBe('low');

    const without = harness();
    await without.provider.complete({
      tenantId: 't1', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }],
    });
    expect(without.body()).not.toHaveProperty('reasoning_effort');
  });

  it('treats an undefined capability as "supported" — every pre-existing caller is unchanged', async () => {
    const { provider, body } = harness();
    await provider.complete({
      tenantId: 't1', model: 'gpt-4o', supportsTemperature: undefined,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body().temperature).toBe(0.2);
  });

  it('carries the capability flags onto the STREAMING request too', async () => {
    const provider = new OpenAiChatProvider(new ConfigService({ OPENAI_API_KEY: 'k' }));
    const create = jest.fn().mockResolvedValue(
      (async function* () {
        yield { model: 'gpt-5.6-luna', choices: [{ delta: { content: 'hi' } }] };
      })(),
    );
    (provider as any).client = { chat: { completions: { create } } };
    for await (const _ of provider.stream({
      tenantId: 't1', model: 'gpt-5.6-luna', temperature: 0.7,
      supportsTemperature: false, reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      // drain
    }
    expect(create.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(create.mock.calls[0][0].reasoning_effort).toBe('low');
    expect(create.mock.calls[0][0].stream).toBe(true);
  });

  it('reports cache-write tokens when the provider returns them', async () => {
    const { provider } = harness({
      usage: {
        prompt_tokens: 100, completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 60 },
      },
    });
    const result = await provider.complete({
      tenantId: 't1', model: 'gpt-5.6-luna', supportsTemperature: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.cachedPromptTokens).toBe(10);
    expect(result.cacheWriteTokens).toBe(60);
  });

  /**
   * Streaming is the dominant chat path (dashboard WS, WhatsApp, guest widget),
   * and its usage arrives on the TERMINAL chunk rather than on a result object.
   * The execution layer copies that chunk field by field, so a value missing
   * here under-bills nearly every turn while the non-streaming path still looks
   * correct — which is exactly how it was missed the first time.
   */
  it('carries cache-write tokens on the terminal STREAM chunk', async () => {
    const provider = new OpenAiChatProvider(new ConfigService({ OPENAI_API_KEY: 'k' }));
    const create = jest.fn().mockResolvedValue(
      (async function* () {
        yield { model: 'gpt-5.6-luna', choices: [{ delta: { content: 'hi' } }] };
        yield {
          model: 'gpt-5.6-luna',
          choices: [{ delta: {} }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 55 },
          },
        };
      })(),
    );
    (provider as any).client = { chat: { completions: { create } } };

    let terminal: { usage?: { cachedPromptTokens?: number; cacheWriteTokens?: number } } | undefined;
    for await (const chunk of provider.stream({
      tenantId: 't1', model: 'gpt-5.6-luna', supportsTemperature: false,
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.done) terminal = chunk;
    }

    expect(terminal?.usage?.cachedPromptTokens).toBe(10);
    expect(terminal?.usage?.cacheWriteTokens).toBe(55);
  });

  it('reports zero cache-write tokens when the provider reports none', async () => {
    const { provider } = harness();
    const result = await provider.complete({
      tenantId: 't1', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }],
    });
    // Zero, not undefined: the cost path multiplies this, and "no data" and
    // "no cache writes" must not price differently.
    expect(result.cacheWriteTokens).toBe(0);
  });
});
