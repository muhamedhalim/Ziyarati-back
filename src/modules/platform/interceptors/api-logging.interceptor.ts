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
 * Records one `api_logs` row per request (the ingestion seam that was previously
 * unwired). Non-blocking: the write is fire-and-forget AFTER the response, so it
 * never adds latency or fails the request. Controlled by env:
 *  - PLATFORM_API_LOG_ENABLED (default 'true')
 *  - PLATFORM_API_LOG_SAMPLE  (0..1, default '1') — fraction of requests logged
 * Health/metrics/docs are always skipped.
 */
@Injectable()
export class ApiLoggingInterceptor implements NestInterceptor {
  private readonly enabled: boolean;
  private readonly sample: number;
  private static readonly SKIP = /^\/?(system\/health|metrics|docs|favicon)/i;

  constructor(
    private readonly apiLogs: ApiLogService,
    private readonly ctx: TenantContextService,
    config: ConfigService,
  ) {
    this.enabled = (config.get<string>('PLATFORM_API_LOG_ENABLED') ?? 'true') !== 'false';
    const s = Number(config.get<string>('PLATFORM_API_LOG_SAMPLE') ?? '1');
    this.sample = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 1;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.enabled) return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (ApiLoggingInterceptor.SKIP.test(req.path) || Math.random() > this.sample) {
      return next.handle();
    }
    const startedAt = Date.now();
    const finalize = (statusCode: number) => this.record(req, context, statusCode, startedAt);
    return next.handle().pipe(
      tap({
        next: () => finalize(context.switchToHttp().getResponse<Response>().statusCode),
        error: (err: { status?: number }) => finalize(err?.status ?? 500),
      }),
    );
  }

  private record(req: Request, context: ExecutionContext, statusCode: number, startedAt: number): void {
    // Tenant from the resolved principal — never from input. Null for platform/anon.
    const tenantId = this.ctx.getTenantId();
    const endpoint =
      (context.getClass()?.name && (req.route as { path?: string })?.path) || req.path;
    void this.apiLogs
      .record(tenantId, {
        endpoint: endpoint?.slice(0, 255),
        method: req.method,
        statusCode,
        responseTimeMs: Date.now() - startedAt,
        ipAddress: (req.ip ?? req.socket?.remoteAddress ?? undefined)?.slice(0, 45),
      })
      .catch(() => undefined);
  }
}
