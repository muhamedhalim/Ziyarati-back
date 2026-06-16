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
      messages: request.messages,
    });
    return {
      content: res.choices[0]?.message?.content ?? '',
      model: res.model,
      promptTokens: res.usage?.prompt_tokens ?? 0,
      completionTokens: res.usage?.completion_tokens ?? 0,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiCompletionChunk> {
    const stream = await this.client!.chat.completions.create({
      model: request.model ?? this.defaultModel,
      temperature: request.temperature ?? 0.2,
      messages: request.messages,
      stream: true,
    });
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content ?? '';
      if (delta) yield { delta, done: false };
    }
    yield { delta: '', done: true };
  }
}
