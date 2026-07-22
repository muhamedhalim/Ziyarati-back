import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { ApiKeyService, AuthenticatedApiKey } from '../api-key.service';
import { TenantContextService } from '../../../core/tenant-context/tenant-context.service';
import { TenantRateLimiterService } from '../../../queue/tenant-rate-limiter.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppError, ErrorCode } from '../../../common/errors';

const DEFAULT_RATE_PER_MINUTE = 120;

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
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyAuthGuard.name);
  private readonly ratePerMinute: number;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly ctx: TenantContextService,
    private readonly rateLimiter: TenantRateLimiterService,
    config: ConfigService,
  ) {
    const configured = Number(
      config.get<string>('INTEGRATION_API_RATE_LIMIT_PER_MINUTE') ?? String(DEFAULT_RATE_PER_MINUTE),
    );
    this.ratePerMinute = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RATE_PER_MINUTE;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const presented = this.extractKey(req);
    const auth = await this.apiKeys.authenticate(presented); // throws UNAUTHORIZED on failure

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
