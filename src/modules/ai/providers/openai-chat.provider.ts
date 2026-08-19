import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import {
  AiCompletionChunk,
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
} from './ai-provider.interface';
import { OpenAiRequestPolicy } from './openai-request-policy';
import { OpenAiClientProvider } from './openai-client.provider';

/**
 * OpenAI Chat Completions provider (GPT-4o / GPT-4.1 family).
 *
 * Real token accounting comes from the API `usage` object. Supports streaming
 * (SSE) via `stream()`. When `OPENAI_API_KEY` is absent, `supports()` returns
 * false so the factory falls back to the Noop provider — the app still runs.
 */
@Injectable()
export class OpenAiChatProvider implements AiCompletionProvider {
  readonly name = 'openai';
  private readonly logger = new Logger('OpenAiChatProvider');
  private readonly client?: OpenAI;
  private readonly defaultModel: string;
  private readonly policy: OpenAiRequestPolicy;

  constructor(
    private readonly config: ConfigService,
    // Optional so direct-construction unit tests (which set `.client`) keep
    // working; Nest injects it. Resolves a per-tenant regional client when Data
    // Residency is enforced (else undefined → the global client is used).
    private readonly clients?: OpenAiClientProvider,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.defaultModel = config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o');
    const timeout = Number(config.get('OPENAI_REQUEST_TIMEOUT_MS', 30_000));
    this.policy = new OpenAiRequestPolicy(
      Number(config.get('OPENAI_PROVIDER_MAX_RETRIES', 2)),
      Number(config.get('OPENAI_RETRY_BASE_MS', 500)),
      this.logger,
    );
    // The SDK retry loop is disabled so this explicit policy is the sole owner.
    if (apiKey) this.client = new OpenAI({ apiKey, timeout, maxRetries: 0 });
  }

  supports(model?: string): boolean {
    return !!this.client && (!model || model.startsWith('gpt-'));
  }

  /**
   * The client to dial for this request: a per-tenant regional client when Data
   * Residency is enforced, else the global client. A fail-closed residency throw
   * propagates (the request is refused, never sent to the global region).
   */
  private async resolveClient(tenantId: string): Promise<OpenAI> {
    const override = this.clients ? await this.clients.forTenant(tenantId) : undefined;
    const client = override ?? this.client;
    if (!client) throw new Error('OPENAI_API_KEY is not configured');
    return client;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const model = request.model ?? this.defaultModel;
    const client = await this.resolveClient(request.tenantId);

    const { value: res, attempts } = await this.policy.execute(
      () => client.chat.completions.create(
        this.requestBody(request, model),
        this.requestOptions(request),
      ),
      'chat.completions',
    );

    const message = res.choices[0]?.message;
    const toolCalls = (message?.tool_calls ?? [])
      .filter((tc) => tc.type === 'function')
      .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

    return {
      content: message?.content ?? '',
      model: res.model,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      cachedPromptTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: this.cacheWriteTokens(res.usage),
      providerAttempts: attempts,
      providerRequestId: res._request_id ?? undefined,
      toolCalls,
    };
  }

  /**
   * `temperature` is OMITTED — not defaulted — for a model whose registry entry
   * says it does not support one. The GPT-5.x family accepts only the default
   * value and returns 400 for any explicit temperature, so the previous
   * unconditional `temperature: request.temperature ?? 0.2` would have failed
   * every single request the moment routing pointed at one.
   *
   * `reasoning_effort` is sent only when the registry names one. It is not a
   * quality dial here so much as a cost dial: reasoning tokens bill as output.
   */
  private requestBody(request: AiCompletionRequest, model: string): OpenAI.Chat.ChatCompletionCreateParamsNonStreaming {
    return {
      model,
      ...(request.supportsTemperature === false
        ? {}
        : { temperature: request.temperature ?? 0.2 }),
      ...(request.reasoningEffort
        ? { reasoning_effort: request.reasoningEffort }
        : {}),
      messages: this.toOpenAiMessages(request.messages),
      ...(request.maxOutputTokens ? { max_completion_tokens: request.maxOutputTokens } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    };
  }

  /**
   * Prompt tokens written INTO the cache this turn, read defensively.
   *
   * The installed SDK's `PromptTokensDetails` type declares only `audio_tokens`
   * and `cached_tokens` — it predates cache-write billing — so the field cannot
   * be read through the typed surface even when the API returns it. It is read
   * off the raw object instead and defaults to 0, so a model that does not
   * report one is billed exactly as it was before.
   *
   * The field name is VERIFIED, not guessed: the live compat run on 2026-08-19
   * printed the raw `usage` object for every registered model and
   * `prompt_tokens_details.cache_write_tokens` is present on gpt-5.6-luna and
   * gpt-5.6-terra and absent on the whole GPT-4.x family. The suite still dumps
   * it, because a wrong name here under-bills silently rather than failing —
   * re-check it when registering any new cache-write-billing model.
   */
  private cacheWriteTokens(usage: unknown): number {
    const details = (usage as { prompt_tokens_details?: Record<string, unknown> } | undefined)
      ?.prompt_tokens_details;
    const raw = details?.cache_write_tokens;
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
  }

  private requestOptions(request: AiCompletionRequest): OpenAI.RequestOptions | undefined {
    if (!request.idempotencyKey && !request.signal) return undefined;
    return {
      ...(request.idempotencyKey ? { headers: { 'Idempotency-Key': request.idempotencyKey } } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    };
  }

  /** Map the provider-agnostic message shape to the OpenAI SDK union type. */
  private toOpenAiMessages(
    messages: AiCompletionRequest['messages'],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id!,
          content: m.content ?? '',
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant',
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: m.role, content: m.content ?? '' } as OpenAI.Chat.ChatCompletionMessageParam;
    });
  }

  /**
   * Streams the answer token-by-token. Also supports tool calling: the model
   * may stream `tool_calls` deltas instead of (or alongside) content — these
   * arrive as partial fragments keyed by index, which are reassembled here and
   * surfaced on the terminal chunk so the execution layer can run the SAME
   * tool-dispatch loop as `complete()` without duplicating that logic.
   */
  async *stream(request: AiCompletionRequest): AsyncIterable<AiCompletionChunk> {
    const model = request.model ?? this.defaultModel;
    const client = await this.resolveClient(request.tenantId);
    // Retry only stream creation. Once any stream data is observed, replaying it
    // could duplicate output/cost, so iteration failures propagate immediately.
    const { value: stream, attempts } = await this.policy.execute(
      () => client.chat.completions.create(
        { ...this.requestBody(request, model), stream: true, stream_options: { include_usage: true } },
        this.requestOptions(request),
      ),
      'chat.completions.stream',
    );

    // Reassemble streamed tool_call fragments by index (OpenAI splits each call's
    // id/name/arguments across multiple chunks).
    const pending = new Map<number, { id: string; name: string; arguments: string }>();
    let resolvedModel = model;
    let usage: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number; cacheWriteTokens?: number; providerAttempts?: number } | undefined;

    for await (const part of stream) {
      resolvedModel = part.model ?? resolvedModel;
      if (part.usage) {
        usage = {
          promptTokens: part.usage.prompt_tokens ?? 0,
          completionTokens: part.usage.completion_tokens ?? 0,
          cachedPromptTokens: part.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: this.cacheWriteTokens(part.usage),
          providerAttempts: attempts,
        };
      }
      const choice = part.choices[0];
      const delta = choice?.delta?.content ?? '';
      if (delta) yield { delta, done: false };

      for (const tc of choice?.delta?.tool_calls ?? []) {
        const entry = pending.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        pending.set(tc.index, entry);
      }
    }

    const toolCalls = Array.from(pending.values())
      .filter((t) => t.id && t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }));

    yield { delta: '', done: true, toolCalls: toolCalls.length ? toolCalls : undefined, usage, model: resolvedModel };
  }
}
