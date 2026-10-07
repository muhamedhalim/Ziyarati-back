import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';

/**
 * Static-bearer-token guard for `GET /metrics` (M14 — see
 * docs/CACHING_QUEUES_AUDIT.md). A Prometheus scraper has no tenant/user JWT,
 * so this is deliberately independent of the business auth stack (the route
 * itself is `@Public()` to skip the global `JwtAuthGuard`, then this guard
 * runs instead) — matching the standard Prometheus `bearer_token` scrape
 * convention.
 *
 * `METRICS_TOKEN` unset: in production, every request is rejected (fail
 * CLOSED — an unauthenticated-by-omission infra endpoint is not acceptable
 * in production); outside production, every request is allowed (dev
 * convenience, matching this repo's existing pattern for e.g.
 * `TAP_TEST_SECRET_KEY` — an unconfigured secret warns, it does not lock
 * developers out of their own dev environment).
 */
@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    const isProduction = this.config.get<string>('NODE_ENV') === 'production';

    if (!token) {
      if (isProduction) {
        throw new UnauthorizedException(
          'Metrics endpoint is not configured (METRICS_TOKEN unset) — refusing all requests in production.',
        );
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';

    if (!presented || !constantTimeEquals(presented, token)) {
      throw new UnauthorizedException(
        'Invalid or missing metrics bearer token.',
      );
    }
    return true;
  }
}

/** Constant-time string comparison — avoids a timing side-channel on the token check. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
