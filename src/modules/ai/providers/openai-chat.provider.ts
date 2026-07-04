import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

import {
  AiCompletionChunk,
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
} from './ai-provider.interface';

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

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.defaultModel = config.get<string>('OPENAI_CHAT_MODEL', 'gpt-4o');
    if (apiKey) this.client = new OpenAI({ apiKey });
  }

  supports(model?: string): boolean {
    return !!this.client && (!model || model.startsWith('gpt-'));
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const model = request.model ?? this.defaultModel;

    const res = await this.client!.chat.completions.create({
      model,
      temperature: request.temperature ?? 0.2,
      messages: this.toOpenAiMessages(request.messages),
      ...(request.tools && request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    });

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
      toolCalls,
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
    const stream = await this.client!.chat.completions.create({
      model,
      temperature: request.temperature ?? 0.2,
      messages: this.toOpenAiMessages(request.messages),
      ...(request.tools && request.tools.length
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    // Reassemble streamed tool_call fragments by index (OpenAI splits each call's
    // id/name/arguments across multiple chunks).
    const pending = new Map<number, { id: string; name: string; arguments: string }>();
    let resolvedModel = model;
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    for await (const part of stream) {
      resolvedModel = part.model ?? resolvedModel;
      if (part.usage) {
        usage = { promptTokens: part.usage.prompt_tokens ?? 0, completionTokens: part.usage.completion_tokens ?? 0 };
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
