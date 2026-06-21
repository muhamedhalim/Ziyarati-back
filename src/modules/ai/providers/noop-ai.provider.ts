import { Injectable, Logger } from '@nestjs/common';
import {
  AiCompletionProvider,
  AiCompletionRequest,
  AiCompletionResult,
} from './ai-provider.interface';

/**
 * Default no-op AI provider — the universal fallback so the RAG/execution flow
 * runs end-to-end without a real LLM integration. Returns a deterministic stub
 * answer and zero token usage. Replace/augment by registering real providers
 * (OpenAI/Anthropic/Azure) into AI_COMPLETION_PROVIDERS; this stays the fallback.
 */
@Injectable()
export class NoopAiProvider implements AiCompletionProvider {
  readonly name = 'noop';
  private readonly logger = new Logger('NoopAiProvider');

  supports(): boolean {
    return true;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    this.logger.log(
      `Simulated AI completion (tenant ${request.tenantId}, ${request.messages.length} msgs)`,
    );
    // The no-op provider never emits tool calls (no real model to plan them), so
    // the executor degrades to a plain text answer — booking tools are inert
    // until a real provider (OpenAI) is configured.
    return {
      content:
        'AI provider is not configured in this environment. ' +
        (lastUser?.content ? `(Echo: "${lastUser.content.slice(0, 120)}")` : ''),
      model: request.model ?? 'noop',
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: [],
      fallback: true,
    };
  }
}
