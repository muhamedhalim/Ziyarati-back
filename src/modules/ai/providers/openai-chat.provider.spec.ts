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
});
