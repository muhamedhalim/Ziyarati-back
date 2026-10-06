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
import { ModelCircuitBreaker } from './model-circuit-breaker';
import {
  MinimizationSession,
  passthroughSession,
} from '../minimization/ai-minimizer';
import {
  DEFAULT_AI_MODEL_ID,
  allowedModelId,
} from '../routing/ai-model-registry';

/**
 * OpenAI Chat Completions provider (the GPT-5.6 family).
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
  /**
   * F-22: this used to be read from `OPENAI_CHAT_MODEL` and described as "the
   * default chat model" — misleading, because `AiModelRouterService` always
   * supplies `request.model` for every real turn, so that branch was dead. It
   * now has two real jobs instead, both under the name `AI_FALLBACK_MODEL`:
   * (1) the rarely-reached model-less-request default, kept for callers that
   * bypass the router entirely (e.g. the live model-compat sweep), and (2)
   * the model `effectiveModel()` substitutes to when the breaker trips.
   */
  private readonly fallbackModel: string;
  private readonly policy: OpenAiRequestPolicy;
  private readonly breaker: ModelCircuitBreaker;
  /**
   * Residency plan P2. ON unless explicitly set to `false`: identifiers are
   * tokenised before a request leaves the process and restored in the reply and
   * in tool-call arguments (see `minimization/ai-minimizer.ts`). The switch
   * exists as a kill-switch for a regression, not as a way to run unprotected.
   */
  private readonly minimizerEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    // Optional so direct-construction unit tests (which set `.client`) keep
    // working; Nest injects it. Resolves a per-tenant regional client when Data
    // Residency is enforced (else undefined → the global client is used).
    private readonly clients?: OpenAiClientProvider,
  ) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    // `AI_FALLBACK_MODEL` is Joi-validated against the registry at boot, so in
    // a real process this is already an allowed id. It is re-checked here
    // because this provider is also constructed directly in unit tests with a
    // hand-built ConfigService that never went through Joi — and because an
    // env var must never be the way a disallowed model reaches the API.
    this.fallbackModel = this.allowedDefault(config.get<string>('AI_FALLBACK_MODEL'));
    this.minimizerEnabled = String(config.get('AI_MINIMIZER_ENABLED', 'true')) !== 'false';
    const timeout = Number(config.get('OPENAI_REQUEST_TIMEOUT_MS', 30_000));
    this.policy = new OpenAiRequestPolicy(
      Number(config.get('OPENAI_PROVIDER_MAX_RETRIES', 2)),
      Number(config.get('OPENAI_RETRY_BASE_MS', 500)),
      this.logger,
    );
    this.breaker = new ModelCircuitBreaker(
      Number(config.get('AI_CIRCUIT_BREAKER_THRESHOLD', 3)),
      Number(config.get('AI_CIRCUIT_BREAKER_COOLDOWN_MS', 60_000)),
      this.logger,
    );
    // The SDK retry loop is disabled so this explicit policy is the sole owner.
    if (apiKey) this.client = new OpenAI({ apiKey, timeout, maxRetries: 0 });
  }

  /**
   * `model.startsWith('gpt-')` used to stand in for "OpenAI can serve this",
   * which made every past, future and misspelled GPT id dispatchable. The
   * registry is the real answer to that question and is now consulted directly,
   * so this method reports provider capability and enforces platform policy with
   * one lookup instead of a prefix guess.
   */
  supports(model?: string): boolean {
    return !!this.client && (!model || allowedModelId(model) !== undefined);
  }

  /**
   * Falls back to the registry's own default when the configured fallback
   * model is missing or not permitted. Warns rather than throws: a bad value
   * here must not stop the process from booting, and the platform default is
   * always a safe model to serve.
   */
  private allowedDefault(configured?: string): string {
    const allowed = allowedModelId(configured);
    if (allowed) return allowed;
    if (configured) {
      this.logger.warn(
        `AI_FALLBACK_MODEL="${configured}" is not a permitted platform model; ` +
          `using "${DEFAULT_AI_MODEL_ID}" instead.`,
      );
    }
    return DEFAULT_AI_MODEL_ID;
  }

  /**
   * F-22 runtime fallback: when `requested` (the router-chosen model) has
   * tripped the breaker, serve the fallback model instead — but only if the
   * fallback isn't ALSO tripped, and only if there IS a different model to
   * fall to. With exactly two registered models this is the whole policy;
   * a fallback model that is itself failing means the platform has no third
   * option, and the error should surface rather than mask a total outage.
   */
  private effectiveModel(requested: string): string {
    if (requested === this.fallbackModel) return requested;
    if (this.breaker.isOpen(requested) && !this.breaker.isOpen(this.fallbackModel)) {
      this.logger.warn(`Substituting fallback model "${this.fallbackModel}" for tripped "${requested}".`);
      return this.fallbackModel;
    }
    return requested;
  }

  /**
   * Runs `operation` and reports its outcome to the breaker for `model`. A
   * generic wrapper (not folded into `OpenAiRequestPolicy`) because the
   * breaker cares about the OUTCOME of the whole retry-bounded call, not
   * individual attempts — `OpenAiRequestPolicy` already retries transient
   * failures internally, so only an error it gives up on should count here.
   */
  private async trackModelHealth<T>(model: string, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      this.breaker.recordSuccess(model);
      return result;
    } catch (error) {
      this.breaker.recordFailure(model);
      throw error;
    }
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

  /**
   * Tokenises identifiers in the outbound messages. A failure here propagates:
   * a request the minimiser could not process is refused, never sent raw.
   */
  private minimize(
    request: AiCompletionRequest,
  ): Pick<MinimizationSession, 'messages' | 'rehydrate' | 'rehydrateToolCalls' | 'streamRehydrator' | 'report' | 'changed'> {
    if (!this.minimizerEnabled) return passthroughSession(request.messages);
    const session = new MinimizationSession(request.messages);
    if (session.changed) {
      // Counts only — never the values.
      this.logger.debug(`minimised outbound prompt ${JSON.stringify(session.report)}`);
    }
    return session;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const model = this.effectiveModel(request.model ?? this.fallbackModel);
    const client = await this.resolveClient(request.tenantId);
    const session = this.minimize(request);
    const outbound = { ...request, messages: session.messages };

    const { value: res, attempts } = await this.trackModelHealth(model, () =>
      this.policy.execute(
        () => client.chat.completions.create(
          this.requestBody(outbound, model),
          this.requestOptions(request),
        ),
        'chat.completions',
      ),
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
      content: session.rehydrate(message?.content ?? ''),
      model: res.model,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
      cachedPromptTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: this.cacheWriteTokens(res.usage),
      providerAttempts: attempts,
      providerRequestId: res._request_id ?? undefined,
      toolCalls: session.rehydrateToolCalls(toolCalls),
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
      // Vision: a user turn carrying images becomes OpenAI's multi-part
      // content array. Only this branch differs from the plain-text mapping —
      // a message with no `imageParts` (every chat turn) takes exactly the
      // same path it always did.
      if (m.role === 'user' && m.imageParts?.length) {
        return {
          role: 'user',
          content: [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...m.imageParts.map((url) => ({
              type: 'image_url' as const,
              // `low` detail is deliberate: the extractor asks for the text on
              // a report, not a fine-grained visual analysis, and detail
              // `high` multiplies the image's token cost several-fold on an
              // endpoint an anonymous visitor can reach.
              image_url: { url, detail: 'low' as const },
            })),
          ],
        } satisfies OpenAI.Chat.ChatCompletionMessageParam;
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
    const model = this.effectiveModel(request.model ?? this.fallbackModel);
    const client = await this.resolveClient(request.tenantId);
    const session = this.minimize(request);
    const outbound = { ...request, messages: session.messages };
    const rehydrator = session.streamRehydrator();
    // Retry only stream creation. Once any stream data is observed, replaying it
    // could duplicate output/cost, so iteration failures propagate immediately.
    // The breaker likewise only sees the creation outcome, for the same reason.
    const { value: stream, attempts } = await this.trackModelHealth(model, () =>
      this.policy.execute(
        () => client.chat.completions.create(
          { ...this.requestBody(outbound, model), stream: true, stream_options: { include_usage: true } },
          this.requestOptions(request),
        ),
        'chat.completions.stream',
      ),
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
      if (delta) {
        const ready = rehydrator.push(delta);
        if (ready) yield { delta: ready, done: false };
      }

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

    const tail = rehydrator.flush();
    if (tail) yield { delta: tail, done: false };

    yield {
      delta: '',
      done: true,
      toolCalls: toolCalls.length ? session.rehydrateToolCalls(toolCalls) : undefined,
      usage,
      model: resolvedModel,
    };
  }
}
