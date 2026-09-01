import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import { ApiLogService } from '../api-log.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';

/**
 * Records an `api_logs` row per request. Non-blocking: the write is
 * fire-and-forget AFTER the response, so it never adds latency to, or fails,
 * the request itself.
 *
 * ── WHAT THIS COSTS (measured, Phase 2.1) ───────────────────────────────────
 * At 8 it/s the overhead is invisible. Near saturation it is not: with this on
 * at 100% and everything else unchanged, a 60/80/100 it/s sweep moved CPU from
 * 83.7% to 97.0% of one core and added ~26,000 SQL statements. That is the cost
 * this policy exists to bound.
 *
 * ── SAMPLING POLICY, AND WHY IT REMOVES NO OBSERVABILITY ────────────────────
 * `api_logs` exists for EXTERNAL-INTEGRATION observability (see ApiLogService's
 * docstring; `/platform/api-logs/stats` meters consumption per API key). So:
 *
 *   - API-key authenticated requests  -> ALWAYS recorded. Sampling these would
 *     corrupt the per-key usage numbers the table exists to report.
 *   - Responses >= 400                -> ALWAYS recorded. Error and security
 *     visibility must never be probabilistic.
 *   - Everything else (ordinary cookie/JWT UI traffic) -> sampled at
 *     PLATFORM_API_LOG_SAMPLE.
 *
 * Sampling the remainder loses nothing, because `main.ts` already records EVERY
 * request's method, status and duration into Prometheus
 * (`recordHttpRequest`) from middleware registered ahead of the whole guard
 * chain — strictly broader coverage than this interceptor, which by
 * construction never sees requests the six global guards reject.
 *
 * ── ENV ─────────────────────────────────────────────────────────────────────
 *  - PLATFORM_API_LOG_ENABLED  default 'true'; default 'false' under
 *    NODE_ENV=test so load tests measure the application, not the logger.
 *  - PLATFORM_API_LOG_SAMPLE   0..1. Default 1 outside production, 0.1 in
 *    production (the carve-outs above are exempt from it).
 */
@Injectable()
export class ApiLoggingInterceptor implements NestInterceptor {
  private readonly enabled: boolean;
  private readonly sample: number;

  /**
   * Paths that never produce a row.
   *
   * The optional `/api/vN` group is load-bearing: routes are mounted under
   * `app.setGlobalPrefix('api/v1')` (main.ts) and `req.path` carries that
   * prefix, so the previous prefix-less pattern matched NOTHING. Every health
   * probe, every Prometheus scrape and every docs hit wrote a row — measured:
   * 2,962 rows for 2,954 application requests in a 90s baseline.
   */
  private static readonly SKIP =
    /^(?:\/api\/v\d+)?\/(system\/health|metrics|docs|favicon)/i;

  constructor(
    private readonly apiLogs: ApiLogService,
    private readonly ctx: TenantContextService,
    config: ConfigService,
  ) {
    const isTest = config.get<string>('NODE_ENV') === 'test';
    const isProduction = config.get<string>('NODE_ENV') === 'production';
    this.enabled =
      (config.get<string>('PLATFORM_API_LOG_ENABLED') ?? (isTest ? 'false' : 'true')) !==
      'false';
    const raw = config.get<string>('PLATFORM_API_LOG_SAMPLE');
    const s = Number(raw ?? (isProduction ? '0.1' : '1'));
    this.sample = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 1;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.enabled) return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (ApiLoggingInterceptor.SKIP.test(req.path)) return next.handle();

    const startedAt = Date.now();
    const finalize = (statusCode: number): void => {
      if (!this.shouldRecord(statusCode)) return;
      this.record(req, context, statusCode, startedAt);
    };
    return next.handle().pipe(
      tap({
        next: () => finalize(context.switchToHttp().getResponse<Response>().statusCode),
        error: (err: { status?: number }) => finalize(err?.status ?? 500),
      }),
    );
  }

  /**
   * The sampling decision, taken AFTER the status code is known so the
   * always-record carve-outs can apply. `sample >= 1` short-circuits without
   * calling `Math.random()` at all — that also makes the common development
   * and test configurations fully deterministic.
   */
  private shouldRecord(statusCode: number): boolean {
    if (this.sample >= 1) return true;
    if (statusCode >= 400) return true;
    if (this.apiKeyId() !== undefined) return true;
    if (this.sample <= 0) return false;
    return Math.random() < this.sample;
  }

  /** API-key principals are synthesized as `apikey:<keyId>` — see ApiKeyAuthGuard. */
  private static readonly API_KEY_PRINCIPAL = /^apikey:(.+)$/;

  private apiKeyId(): string | undefined {
    const principalId = this.ctx.getUser()?.id;
    return principalId
      ? ApiLoggingInterceptor.API_KEY_PRINCIPAL.exec(principalId)?.[1]
      : undefined;
  }

  private record(req: Request, context: ExecutionContext, statusCode: number, startedAt: number): void {
    // Tenant from the resolved principal — never from input. Null for platform/anon.
    const tenantId = this.ctx.getTenantId();
    const apiKeyId = this.apiKeyId();
    const endpoint =
      (context.getClass()?.name && (req.route as { path?: string })?.path) || req.path;
    void this.apiLogs
      .record(tenantId, {
        endpoint: endpoint?.slice(0, 255),
        method: req.method,
        statusCode,
        responseTimeMs: Date.now() - startedAt,
        ipAddress: (req.ip ?? req.socket?.remoteAddress ?? undefined)?.slice(0, 45),
        apiKeyId,
      })
      .catch(() => undefined);
  }
}
