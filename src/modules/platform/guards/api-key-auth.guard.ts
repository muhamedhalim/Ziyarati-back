import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { ApiKeyService, AuthenticatedApiKey } from '../api-key.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { TenantRateLimiterService } from '../../../queue/tenant-rate-limiter.service';
import { MetricsService } from '../../../metrics/metrics.service';
import { ApiLogService } from '../api-log.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

export const DEFAULT_RATE_PER_MINUTE = 120;

/** At most one `api_logs` row per rejected key per window — a hammering client can't flood the log. */
const AUTH_FAILURE_LOG_WINDOW_MS = 60_000;
/** Bound on remembered keys so the throttle map can never grow without limit. */
const AUTH_FAILURE_LOG_MAX_KEYS = 1_000;

type RejectedReason = 'missing' | 'unknown' | 'inactive' | 'expired';
const REJECTED_REASONS: readonly RejectedReason[] = ['missing', 'unknown', 'inactive', 'expired'];

/**
 * Authenticates machine-to-machine requests with a platform API key.
 *
 * Accepts the key via `X-API-Key: zk_...` or `Authorization: ApiKey zk_...`.
 * On success it builds a synthetic principal (`request.user`) carrying the key's
 * tenant + permissions and pushes it into the tenant context, so the SAME
 * downstream stack (ActiveTenantGuard, IntegrationScopeGuard, tenant-scoped
 * services, `requireTenantId`) works identically to a JWT request.
 *
 * Invoked by JwtAuthGuard (global) for routes marked `@ApiKeyRoute()` — see
 * jwt-auth.guard.ts for why authentication must happen there rather than in a
 * route-level guard. `@ApiKeyProtected()` applies that marker automatically.
 *
 * Per-key rate limiting: reuses the existing Redis token-bucket
 * (TenantRateLimiterService), namespaced `apikey:<keyId>` so it never collides
 * with a tenant's campaign-sending buckets. The limit is configurable
 * (`INTEGRATION_API_RATE_LIMIT_PER_MINUTE`, default 120/min) rather than
 * hardcoded. If Redis itself is unavailable, the request is ALLOWED — a
 * deliberate fail-open choice for this read-only API so a Redis outage never
 * takes down external integrations platform-wide; the failure is logged.
 *
 * Rejections are observable (SEC-06). `ApiLoggingInterceptor` runs AFTER the
 * guards, so a 401 from here never reached `api_logs`. This guard therefore
 * records it itself: a REVOKED / DISABLED / EXPIRED key is attributed to its
 * tenant (the key row names it) as a 401 row — at most one per key per minute —
 * so an owner can see a dead credential still being used. A key that matches
 * nothing has no tenant to show it to, so it is only counted in Prometheus
 * (`api_key_auth_failures_total`), never written per request: that path is
 * open to anyone on the internet and must not become a way to fill the table.
 * Nothing here can change the response — failures to record are swallowed.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);
  private readonly ratePerMinute: number;
  /** keyId → last time a rejection row was written for it (per process). */
  private readonly lastRejectionLoggedAt = new Map<string, number>();

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly ctx: TenantContextService,
    private readonly rateLimiter: TenantRateLimiterService,
    config: ConfigService,
    private readonly apiLogs: ApiLogService,
    private readonly metrics: MetricsService,
  ) {
    const configured = Number(
      config.get<string>('INTEGRATION_API_RATE_LIMIT_PER_MINUTE') ?? String(DEFAULT_RATE_PER_MINUTE),
    );
    this.ratePerMinute = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RATE_PER_MINUTE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const presented = this.extractKey(req);
    let auth: AuthenticatedApiKey;
    try {
      auth = await this.apiKeys.authenticate(presented); // throws UNAUTHORIZED on failure
    } catch (err) {
      this.observeRejection(req, err);
      throw err;
    }

    await this.enforceRateLimit(auth);

    const user: AuthenticatedUser = {
      id: `apikey:${auth.keyId}`,
      tenantId: auth.tenantId,
      email: null,
      roles: [],
      permissions: auth.permissions,
    };
    (req as Request & { user?: AuthenticatedUser }).user = user;
    this.ctx.setPrincipal(user);
    return true;
  }

  /** Count the rejection, and log it against the key's tenant when one is known. Never throws. */
  private observeRejection(req: Request, err: unknown): void {
    try {
      const internal = (err as { internalContext?: Record<string, unknown> })?.internalContext;
      const reason = REJECTED_REASONS.find((r) => r === internal?.reason);
      if (!reason) return; // not an authentication failure (e.g. a DB error) — nothing to attribute
      this.metrics.recordApiKeyAuthFailure(reason);

      const keyId = typeof internal?.keyId === 'string' ? internal.keyId : undefined;
      const tenantId = typeof internal?.tenantId === 'string' ? internal.tenantId : undefined;
      if (!keyId || !tenantId || !this.shouldLogRejection(keyId)) return;

      const endpoint = (req.route as { path?: string } | undefined)?.path || req.path;
      void this.apiLogs
        .record(tenantId, {
          endpoint: endpoint?.slice(0, 255),
          method: req.method,
          statusCode: 401,
          ipAddress: (req.ip ?? req.socket?.remoteAddress ?? undefined)?.slice(0, 45),
          apiKeyId: keyId,
        })
        .catch(() => undefined);
    } catch (observeErr) {
      this.logger.warn(`Could not record API key rejection: ${(observeErr as Error)?.message}`);
    }
  }

  private shouldLogRejection(keyId: string): boolean {
    const now = Date.now();
    const last = this.lastRejectionLoggedAt.get(keyId);
    if (last !== undefined && now - last < AUTH_FAILURE_LOG_WINDOW_MS) return false;
    if (this.lastRejectionLoggedAt.size >= AUTH_FAILURE_LOG_MAX_KEYS) {
      for (const [id, at] of this.lastRejectionLoggedAt) {
        if (now - at >= AUTH_FAILURE_LOG_WINDOW_MS) this.lastRejectionLoggedAt.delete(id);
      }
      // Still full of recent entries: drop everything rather than grow unbounded.
      if (this.lastRejectionLoggedAt.size >= AUTH_FAILURE_LOG_MAX_KEYS) this.lastRejectionLoggedAt.clear();
    }
    this.lastRejectionLoggedAt.set(keyId, now);
    return true;
  }

  private async enforceRateLimit(auth: AuthenticatedApiKey): Promise<void> {
    let decision: Awaited<ReturnType<TenantRateLimiterService['consume']>>;
    try {
      decision = await this.rateLimiter.consume(auth.tenantId ?? 'platform', `apikey:${auth.keyId}`, {
        ratePerMinute: this.ratePerMinute,
        dailyCap: null,
        monthlyCap: null,
      });
    } catch (err) {
      // Redis unavailable — fail OPEN (see class docstring) rather than 500ing
      // every integration request over an infra dependency of a rate LIMIT.
      this.logger.warn(
        `Rate limiter unavailable for API key ${auth.keyId}, allowing request: ${(err as Error)?.message}`,
      );
      return;
    }
    if (!decision.allowed) {
      const retryAfterMs = decision.reason === 'RATE' ? decision.retryAfterMs : 60_000;
      throw new AppError(ErrorCode.RATE_LIMITED, {
        message: 'API key rate limit exceeded — slow down and retry later',
        publicContext: { retryAfterMs },
      });
    }
  }

  private extractKey(req: Request): string | undefined {
    const headerKey = req.header('x-api-key');
    if (headerKey) return headerKey.trim();
    const authz = req.header('authorization');
    if (authz && /^ApiKey\s+/i.test(authz)) return authz.replace(/^ApiKey\s+/i, '').trim();
    return undefined;
  }
}
