import { AiBatchStatus } from '../execution/ai-execution.constants';

/**
 * A single line of a Batch API input file (one logical request). `customId` is
 * the caller-chosen key echoed back on the matching result line — the ONLY safe
 * way to bind results (the provider returns lines in an unspecified order).
 */
export interface AiBatchLineRequest {
  customId: string;
  method: 'POST';
  /** AiBatchEndpoint, e.g. '/v1/embeddings' | '/v1/chat/completions'. */
  url: string;
  body: Record<string, unknown>;
}

/** A parsed result line from a completed batch's output or error file. */
export interface AiBatchLineResult {
  customId: string;
  statusCode: number | null;
  /** The success response body (e.g. an embeddings response), or null. */
  body: Record<string, unknown> | null;
  /** Populated when the line failed. */
  error: { code?: string; message?: string } | null;
}

/** Normalized view of a remote batch's state. */
export interface AiBatchHandle {
  externalId: string;
  status: AiBatchStatus;
  inputFileId?: string | null;
  outputFileId?: string | null;
  errorFileId?: string | null;
  counts: { total: number; completed: number; failed: number };
}

export interface AiBatchSubmitInput {
  tenantId: string;
  endpoint: string;
  requests: AiBatchLineRequest[];
  completionWindow?: string;
  /** Small string metadata attached to the remote batch (no sensitive data). */
  metadata?: Record<string, string>;
}

export interface AiBatchCreateInput {
  tenantId: string;
  inputFileId: string;
  endpoint: string;
  completionWindow?: string;
  metadata?: Record<string, string>;
}

/**
 * Batch-provider port. The batch execution layer depends ONLY on this interface,
 * never on the OpenAI SDK — mirroring AiCompletionProvider / AiEmbeddingProvider.
 */
export interface AiBatchProvider {
  readonly name: string;
  /** True only when a real backend is configured (no key ⇒ false). */
  isConfigured(): boolean;
  /**
   * Upload the JSONL input file. Split from `createBatch` so the caller can
   * persist the input file id BEFORE the (non-idempotent) batch create, which is
   * what makes crash recovery around submission safe. Verifies the tenant's
   * regional deployment BEFORE any bytes are uploaded (fail-closed).
   */
  uploadInputFile(
    tenantId: string,
    requests: AiBatchLineRequest[],
  ): Promise<{ inputFileId: string }>;
  /** Create the remote batch from an already-uploaded input file. */
  createBatch(input: AiBatchCreateInput): Promise<AiBatchHandle>;
  /** Convenience: upload + create in one call (used by tests / simple callers). */
  submit(input: AiBatchSubmitInput): Promise<AiBatchHandle>;
  poll(tenantId: string, externalId: string): Promise<AiBatchHandle>;
  cancel(tenantId: string, externalId: string): Promise<AiBatchHandle>;
  /**
   * Find a remote batch this tenant created carrying `correlationId` in its
   * metadata. Used to reconcile a submission whose create outcome is unknown —
   * so we never create a duplicate remote batch. Returns null if none exists.
   */
  findByCorrelation(
    tenantId: string,
    correlationId: string,
  ): Promise<AiBatchHandle | null>;
  fetchResults(
    tenantId: string,
    handle: AiBatchHandle,
  ): Promise<{ outputs: AiBatchLineResult[]; errors: AiBatchLineResult[] }>;
}

/** Single-provider DI token for the batch backend. */
export const AI_BATCH_PROVIDER = Symbol('AI_BATCH_PROVIDER');

// ── Pure, network-free helpers (exported for unit testing) ──────────────────

/** Serialize batch requests to newline-delimited JSON (JSONL). */
export function buildBatchJsonl(requests: AiBatchLineRequest[]): string {
  return requests
    .map((r) =>
      JSON.stringify({
        custom_id: r.customId,
        method: r.method,
        url: r.url,
        body: r.body,
      }),
    )
    .join('\n');
}

/**
 * Parse a batch output/error file (JSONL) into result lines. Tolerant of blank
 * lines and malformed rows (skipped). A line succeeds only when it carries no
 * `error` and a 2xx status code.
 */
export function parseBatchResultsJsonl(text: string): AiBatchLineResult[] {
  const results: AiBatchLineResult[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: {
      custom_id?: unknown;
      response?: { status_code?: unknown; body?: unknown } | null;
      error?: { code?: unknown; message?: unknown } | null;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const customId =
      typeof parsed.custom_id === 'string' ? parsed.custom_id : '';
    if (!customId) continue;
    const response = parsed.response ?? null;
    const statusCode =
      response && typeof response.status_code === 'number'
        ? response.status_code
        : null;
    const body =
      response && response.body && typeof response.body === 'object'
        ? (response.body as Record<string, unknown>)
        : null;
    let error: AiBatchLineResult['error'] = null;
    if (parsed.error) {
      error = {
        code:
          typeof parsed.error.code === 'string' ? parsed.error.code : undefined,
        message:
          typeof parsed.error.message === 'string'
            ? parsed.error.message
            : undefined,
      };
    } else if (statusCode !== null && statusCode >= 400) {
      error = { code: `HTTP_${statusCode}`, message: 'request failed' };
    }
    results.push({ customId, statusCode, body, error });
  }
  return results;
}

/** Sum embedding tokens across successful embedding result lines. */
export function sumEmbeddingTokens(results: AiBatchLineResult[]): number {
  let total = 0;
  for (const r of results) {
    const usage = (r.body?.usage ?? null) as { total_tokens?: unknown } | null;
    if (usage && typeof usage.total_tokens === 'number')
      total += usage.total_tokens;
  }
  return total;
}

/** Extract the first embedding vector from an embeddings response body. */
export function extractEmbeddingVector(
  body: Record<string, unknown> | null,
): number[] | null {
  const data = (body?.data ?? null) as Array<{ embedding?: unknown }> | null;
  const embedding = Array.isArray(data) ? data[0]?.embedding : undefined;
  if (
    Array.isArray(embedding) &&
    embedding.every((n) => typeof n === 'number')
  ) {
    return embedding as number[];
  }
  return null;
}
