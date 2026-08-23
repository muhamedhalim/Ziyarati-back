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
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Null on an assistant turn that only requests tool calls. */
  content: string | null;
  /** Present on an assistant turn that requests function/tool calls. */
  tool_calls?: AiToolCall[];
  /** Present on a `tool` role message (the result fed back to the model). */
  tool_call_id?: string;
  /** Tool name (on a `tool` role message). */
  name?: string;
  /**
   * Images to send alongside `content` on a `user` turn, as `data:` URLs.
   *
   * Additive and optional: `content` keeps its `string | null` shape, so every
   * existing caller, adapter and token estimate is untouched. An adapter whose
   * model has no vision path is free to ignore this field — the text still
   * carries the turn.
   *
   * Used by exactly one caller today: the guest-attachment extractor's
   * single, non-streaming pass that turns an uploaded image into text. Chat
   * turns never carry images, so an attachment is paid for once at upload
   * rather than re-uploaded on every subsequent turn about it.
   */
  imageParts?: string[];
}

/** An OpenAI-style function/tool definition (JSON-schema parameters). */
export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A tool call the model wants executed. `arguments` is a raw JSON string. */
export interface AiToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AiCompletionRequest {
  tenantId: string;
  model?: string;
  temperature?: number;
  /**
   * Model CAPABILITIES the caller resolved from `AI_MODEL_REGISTRY`, passed as
   * two plain facts rather than the registry object itself so this port stays
   * provider-agnostic (an Anthropic or Azure adapter has the same two questions
   * and no business importing an OpenAI-shaped routing type).
   *
   * `supportsTemperature: false` means the provider MUST omit `temperature`
   * entirely — the GPT-5.x family rejects any non-default value and 400s the
   * request. Undefined ⇒ assume supported, which is the behaviour every model
   * had before this field existed.
   */
  supportsTemperature?: boolean;
  /** Sent as `reasoning_effort` when the resolved model is a reasoning model. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /** Fully-assembled message list (system + retrieved context + history + user). */
  messages: AiChatMessage[];
  /** Tools the model may call. When present the provider enables tool calling. */
  tools?: AiToolDefinition[];
  maxOutputTokens?: number;
  idempotencyKey?: string;
  feature?: string;
  route?: string;
  channel?: string;
  signal?: AbortSignal;
}

export interface AiCompletionResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  /**
   * Prompt tokens the provider WROTE into its cache this turn, for models that
   * bill cache writes above the uncached input rate (GPT-5.6 = 1.25x). Zero or
   * undefined for every model that does not — including all of GPT-4.x — in
   * which case nothing extra is billed.
   */
  cacheWriteTokens?: number;
  providerAttempts?: number;
  providerRequestId?: string;
  /** Tool calls the model requested this turn (empty/undefined → plain answer). */
  toolCalls?: AiToolCall[];
  /** True when produced by the no-op fallback (no real provider). */
  fallback?: boolean;
}

/**
 * A single streamed delta (SSE). `done` marks the terminal chunk, which MAY also
 * carry accumulated `toolCalls` (reassembled from streamed function-call
 * fragments) and real `usage`/`model` when the provider's streaming API returns
 * them — enabling tool-calling on the streaming path, not just `complete()`.
 */
export interface AiCompletionChunk {
  delta: string;
  done: boolean;
  /** Present on the terminal chunk when the model requested tool calls. */
  toolCalls?: AiToolCall[];
  /** Present on the terminal chunk when the provider reports real token usage. */
  usage?: { promptTokens: number; completionTokens: number; cachedPromptTokens?: number; cacheWriteTokens?: number; providerAttempts?: number };
  /** Present on the terminal chunk (the resolved model id). */
  model?: string;
}

export interface AiCompletionProvider {
  /** Human-readable provider name (for logs/diagnostics). */
  readonly name: string;
  /** Returns true if this provider can serve the requested model. */
  supports(model?: string): boolean;
  /** Generates a completion. Must not throw for expected failures — return a
   *  fallback result so the executor can still persist + degrade gracefully. */
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
  /** Optional token-by-token streaming (SSE). Providers that support it yield
   *  deltas then a terminal `{ done: true }`. */
  stream?(request: AiCompletionRequest): AsyncIterable<AiCompletionChunk>;
}

/** Multi-provider DI token: an array of registered AI completion providers. */
export const AI_COMPLETION_PROVIDERS = Symbol('AI_COMPLETION_PROVIDERS');

// ── Embeddings ───────────────────────────────────────────────────────────────

export interface AiEmbeddingResult {
  /** One vector per input text, in input order. */
  vectors: number[][];
  model: string;
  /** Total embedding tokens billed (for cost accounting). */
  tokens: number;
  cacheHits?: number;
  cacheMisses?: number;
  providerAttempts?: number;
}

export interface AiEmbeddingContext {
  kind?: 'QUERY' | 'CONTENT' | 'MEMORY';
  feature?: string;
  route?: string;
  channel?: string;
  aiConversationId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Embedding provider port. Used ONLY by the RAG retrieval layer (to embed the
 * query) and the ingestion pipeline (to embed chunks) — never by the execution,
 * analytics, controller or DTO layers.
 */
export interface AiEmbeddingProvider {
  /** True only when a real backend is configured (no key → false). */
  isConfigured(): boolean;
  /** Embedding vector dimension (must match the pgvector column). */
  readonly dimension: number;
  /** Batch-embed texts. Throws if not configured — callers guard with isConfigured(). */
  embed(tenantId: string, texts: string[], context?: AiEmbeddingContext): Promise<AiEmbeddingResult>;
}

/** Single-provider DI token for the embedding backend. */
export const AI_EMBEDDING_PROVIDER = Symbol('AI_EMBEDDING_PROVIDER');
