/**
 * AI completion-provider abstraction (strategy pattern).
 *
 * The execution/RAG layers depend ONLY on this interface — never on the OpenAI /
 * Anthropic / Azure SDKs. Concrete adapters (OpenAIProvider, AnthropicProvider,
 * AzureOpenAIProvider) implement `supports()` for the requested model and are
 * registered into the `AI_COMPLETION_PROVIDERS` multi-provider token; the factory
 * resolves one at execution time. Adding a real provider later requires NO change
 * to AiExecutionService.
 */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionRequest {
  tenantId: string;
  model?: string;
  temperature?: number;
  /** Fully-assembled message list (system + retrieved context + history + user). */
  messages: AiChatMessage[];
}

export interface AiCompletionResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** True when produced by the no-op fallback (no real provider). */
  fallback?: boolean;
}

export interface AiCompletionProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can serve the requested model. */
  supports(model?: string): boolean;
  /** Generates a completion. Must not throw for expected failures — return a
   *  fallback result so the executor can still persist + degrade gracefully. */
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

/** Multi-provider DI token: an array of registered AI completion providers. */
export const AI_COMPLETION_PROVIDERS = Symbol('AI_COMPLETION_PROVIDERS');
