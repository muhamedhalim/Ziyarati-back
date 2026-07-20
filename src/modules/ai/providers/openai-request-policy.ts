import { Logger } from '@nestjs/common';

type ProviderError = Error & {
  status?: number;
  code?: string;
  headers?: Headers | { get(name: string): string | null };
};

export class OpenAiRequestPolicy {
  constructor(
    private readonly maxRetries: number,
    private readonly baseDelayMs: number,
    private readonly logger: Logger,
  ) {}

  async execute<T>(operation: () => Promise<T>, operationName: string): Promise<{ value: T; attempts: number }> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return { value: await operation(), attempts: attempt };
      } catch (error) {
        const retryable = isRetryableOpenAiError(error);
        if (!retryable || attempt > this.maxRetries) throw error;
        const delay = retryAfterMs(error) ?? this.jitteredDelay(attempt);
        const e = error as ProviderError;
        this.logger.warn(`OpenAI ${operationName} retry attempt=${attempt} status=${e.status ?? 'network'} code=${e.code ?? e.name}`);
        await this.sleep(delay);
      }
    }
  }

  private jitteredDelay(attempt: number): number {
    const cap = this.baseDelayMs * 2 ** Math.max(0, attempt - 1);
    return Math.max(1, Math.floor(cap / 2 + Math.random() * cap / 2));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function isRetryableOpenAiError(error: unknown): boolean {
  const e = error as ProviderError;
  if (e?.status === 429 || (typeof e?.status === 'number' && e.status >= 500)) return true;
  if (typeof e?.status === 'number') return false;
  const name = e?.name ?? '';
  const code = e?.code ?? '';
  return name === 'APIConnectionError'
    || name === 'APIConnectionTimeoutError'
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
}

/**
 * True when a write's outcome is genuinely UNKNOWN: the request was likely sent
 * but no HTTP response was received (connection reset/timeout/DNS mid-flight). A
 * received HTTP status (4xx/5xx) is NOT ambiguous — the server processed and
 * rejected it, so the remote object was not created. Used to decide whether a
 * batch submission may have created a remote batch we didn't record.
 */
export function isAmbiguousOutcome(error: unknown): boolean {
  const e = error as ProviderError;
  if (typeof e?.status === 'number') return false; // got an HTTP response → not ambiguous
  const name = e?.name ?? '';
  const code = e?.code ?? '';
  return name === 'APIConnectionError'
    || name === 'APIConnectionTimeoutError'
    || ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'].includes(code);
}

export function retryAfterMs(error: unknown): number | undefined {
  const raw = (error as ProviderError)?.headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 60_000)) : undefined;
}
