import { Injectable, Logger } from '@nestjs/common';

import { PaymentsConfig } from '../../payments.config';
import type { TapCharge, TapRefund, TapToken } from './tap.types';

export interface TapResponse<T = any> {
  /** HTTP 2xx. */
  ok: boolean;
  /** HTTP status; 0 = no response at all (network error, timeout, no fetch). */
  status: number;
  json: T;
  /**
   * The outcome is UNKNOWN rather than a definitive answer: no response, a 5xx,
   * or a 429 that survived the bounded retries. A caller must never read this
   * as "the payment failed" — the request may well have been processed.
   */
  transient: boolean;
  /** First `errors[].code` Tap returned, e.g. `1117`. For logs/audit, never users. */
  errorCode?: string;
  errorDescription?: string;
}

const MAX_429_RETRIES = 2;
const BACKOFF_BASE_MS = 250;

/**
 * The single seam between ZiyaraTech and `https://api.tap.company`.
 *
 * Everything Tap-specific about transport lives here — bearer auth, timeout,
 * 429 backoff, error-body parsing — so the gateway adapter, the subscription
 * adapter (later phases) and the webhook handler cannot each re-implement
 * (and subtly diverge on) it.
 *
 * Never logs the key, a request/response body, a token or any card/payer data:
 * only method, path, HTTP status and Tap's numeric error code.
 */
@Injectable()
export class TapApiClient {
  private readonly logger = new Logger('TapApiClient');

  constructor(private readonly config: PaymentsConfig) {}

  /** TRUE when a secret key exists for the active `TAP_ENV`. */
  get isConfigured(): boolean {
    return !!this.config.tapSecretKey;
  }

  createCharge(body: Record<string, unknown>): Promise<TapResponse<TapCharge>> {
    return this.request('POST', '/v2/charges', body);
  }

  getCharge(chargeId: string): Promise<TapResponse<TapCharge>> {
    return this.request('GET', `/v2/charges/${encodeURIComponent(chargeId)}`);
  }

  createRefund(body: Record<string, unknown>): Promise<TapResponse<TapRefund>> {
    return this.request('POST', '/v2/refunds', body);
  }

  getRefund(refundId: string): Promise<TapResponse<TapRefund>> {
    return this.request('GET', `/v2/refunds/${encodeURIComponent(refundId)}`);
  }

  /**
   * Single-use token (5 min) for a SAVED card — what a merchant-initiated charge
   * takes as `source.id`. A saved-card id alone is not accepted by /charges.
   */
  createTokenFromSavedCard(
    body: Record<string, unknown>,
  ): Promise<TapResponse<TapToken>> {
    return this.request('POST', '/v2/tokens', body);
  }

  /** Remove a saved card at Tap. */
  deleteSavedCard(
    customerId: string,
    cardId: string,
  ): Promise<TapResponse<{ deleted?: boolean; id?: string }>> {
    return this.request(
      'DELETE',
      `/v2/card/${encodeURIComponent(customerId)}/${encodeURIComponent(cardId)}`,
    );
  }

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<TapResponse<T>> {
    const secret = this.config.tapSecretKey;
    if (!secret) {
      // A configuration problem, not an outage: say so, don't claim "transient".
      this.logger.error(
        `Tap ${method} ${path} skipped: no secret key for TAP_ENV`,
      );
      return {
        ok: false,
        status: 0,
        json: {} as T,
        transient: false,
        errorCode: 'TAP_NOT_CONFIGURED',
      };
    }

    const fetchFn = (globalThis as any).fetch as
      | ((url: string, init?: any) => Promise<any>)
      | undefined;
    if (!fetchFn) {
      this.logger.error('global fetch is unavailable in this runtime');
      return {
        ok: false,
        status: 0,
        json: {} as T,
        transient: true,
        errorCode: 'NO_FETCH',
      };
    }

    for (let attempt = 0; ; attempt += 1) {
      const res = await this.once<T>(fetchFn, secret, method, path, body);
      // 429 = rejected BEFORE processing, so a retry cannot double-act.
      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  private async once<T>(
    fetchFn: (url: string, init?: any) => Promise<any>,
    secret: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<TapResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.tapRequestTimeoutMs,
    );
    try {
      const res = await fetchFn(`${this.config.tapApiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as any;
      const status: number = res.status;
      const firstError = Array.isArray(json?.errors)
        ? json.errors[0]
        : undefined;
      const transient = status === 429 || status >= 500;
      if (!res.ok) {
        this.logger.warn(
          `Tap ${method} ${path} -> ${status}${firstError?.code ? ` (error ${firstError.code})` : ''}`,
        );
      }
      return {
        ok: !!res.ok,
        status,
        json: json as T,
        transient,
        errorCode:
          firstError?.code != null ? String(firstError.code) : undefined,
        errorDescription:
          typeof firstError?.description === 'string'
            ? firstError.description
            : undefined,
      };
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError';
      this.logger.error(
        `Tap ${method} ${path} ${aborted ? 'timed out' : 'unreachable'}`,
      );
      return {
        ok: false,
        status: 0,
        json: {} as T,
        transient: true,
        errorCode: aborted ? 'TIMEOUT' : 'UNREACHABLE',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Separate method so tests can skip the real delay. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
