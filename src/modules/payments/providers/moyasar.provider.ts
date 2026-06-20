import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  GatewayCreatePaymentRequest,
  GatewayPaymentResult,
  GatewayPaymentStatus,
  GatewayRefundRequest,
  GatewayRefundResult,
  PaymentGatewayProvider,
} from './payment-gateway.provider.interface';

/**
 * Moyasar gateway adapter (Saudi Arabia).
 *
 * This is the ONLY place that knows about Moyasar. Credentials are read from
 * ConfigService (platform-level env: MOYASAR_SECRET_KEY / MOYASAR_API_BASE) and
 * never leave this class. Moyasar works in the smallest currency unit (halalas),
 * so amounts are converted on the way out and the domain keeps major units.
 *
 * Safety: `supports()` returns false when no secret key is configured, so the
 * factory transparently falls back to the Noop provider — the app boots and
 * runs locally with no live integration and no network calls.
 *
 * HTTP uses the Node ≥18 global `fetch`. It is reached through `globalThis` so
 * the build needs no extra dependency or DOM lib; this adapter is not exercised
 * in dev (Noop fallback) but ships as the real integration seam.
 */
@Injectable()
export class MoyasarProvider implements PaymentGatewayProvider {
  readonly name = 'moyasar';
  private readonly logger = new Logger('MoyasarProvider');

  constructor(private readonly config: ConfigService) {}

  private get secretKey(): string {
    return this.config.get<string>('MOYASAR_SECRET_KEY') ?? '';
  }

  private get apiBase(): string {
    return (
      this.config.get<string>('MOYASAR_API_BASE') || 'https://api.moyasar.com/v1'
    );
  }

  /** Handle 'moyasar' (or an unspecified gateway) only when credentials exist. */
  supports(gatewayName?: string): boolean {
    const matches = !gatewayName || gatewayName.toLowerCase() === this.name;
    return matches && this.secretKey.length > 0;
  }

  async createPayment(
    request: GatewayCreatePaymentRequest,
  ): Promise<GatewayPaymentResult> {
    const body = {
      amount: this.toMinorUnits(request.amount),
      currency: request.currency,
      description: request.description ?? `Payment ${request.paymentId}`,
      callback_url: request.callbackUrl,
      metadata: { ...request.metadata, paymentId: request.paymentId },
    };

    const { ok, json } = await this.request('POST', '/payments', body);
    if (!ok) {
      return {
        success: false,
        status: 'failed',
        failureReason: this.extractError(json),
        raw: json,
      };
    }

    return {
      success: true,
      gatewayPaymentId: json?.id,
      status: this.mapStatus(json?.status),
      redirectUrl: json?.source?.transaction_url ?? json?.callback_url,
      raw: json,
    };
  }

  async verifyPayment(gatewayPaymentId: string): Promise<GatewayPaymentResult> {
    const { ok, json } = await this.request(
      'GET',
      `/payments/${encodeURIComponent(gatewayPaymentId)}`,
    );
    if (!ok) {
      return {
        success: false,
        status: 'failed',
        failureReason: this.extractError(json),
        raw: json,
      };
    }

    return {
      success: true,
      gatewayPaymentId: json?.id ?? gatewayPaymentId,
      status: this.mapStatus(json?.status),
      // Moyasar reports `amount` as the captured total in halalas (smallest unit)
      // and `currency` as the ISO code — surfaced so the domain reconciles them
      // against our expected payment before booking it PAID.
      capturedMinorUnits:
        json?.amount != null ? Math.round(Number(json.amount)) : undefined,
      capturedCurrency: json?.currency,
      // Moyasar reports `refunded` as cumulative halalas (smallest unit).
      refundedMinorUnits:
        json?.refunded != null ? Math.round(Number(json.refunded)) : undefined,
      raw: json,
    };
  }

  async refundPayment(
    request: GatewayRefundRequest,
  ): Promise<GatewayRefundResult> {
    const { ok, json } = await this.request(
      'POST',
      `/payments/${encodeURIComponent(request.gatewayPaymentId)}/refund`,
      { amount: this.toMinorUnits(request.amount) },
    );
    if (!ok) {
      return {
        success: false,
        failureReason: this.extractError(json),
        raw: json,
      };
    }

    return { success: true, gatewayRefundId: json?.id, raw: json };
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  /** Moyasar amounts are in the smallest unit (halalas / cents). */
  private toMinorUnits(amount: number): number {
    return Math.round(Number(amount) * 100);
  }

  /** Normalize Moyasar's status vocabulary into our 3-state gateway status. */
  private mapStatus(status?: string): GatewayPaymentStatus {
    switch ((status ?? '').toLowerCase()) {
      case 'paid':
      case 'captured':
      case 'authorized':
        return 'paid';
      case 'failed':
      case 'voided':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private authHeader(): string {
    // Moyasar uses HTTP Basic auth: secret key as username, empty password.
    return `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`;
  }

  private extractError(json: any): string {
    return json?.message ?? json?.errors ?? 'Gateway request failed';
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; json: any }> {
    const fetchFn = (globalThis as any).fetch as
      | ((url: string, init?: any) => Promise<any>)
      | undefined;
    if (!fetchFn) {
      this.logger.error('global fetch is unavailable in this runtime');
      return { ok: false, status: 0, json: { message: 'fetch unavailable' } };
    }

    try {
      const res = await fetchFn(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, json };
    } catch (err) {
      this.logger.error(`Moyasar ${method} ${path} failed`, err as Error);
      return { ok: false, status: 0, json: { message: 'Gateway unreachable' } };
    }
  }
}
