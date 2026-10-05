import { ExecutionContext, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
} from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Request } from 'express';
import { createHash } from 'node:crypto';

import { ApiKeyService } from '../../modules/platform/api-key.service';
import { INTEGRATION_SCOPE } from '../../modules/platform/integration-scopes.constants';
import { PublicDiscoveryController } from '../../modules/public-discovery/public-discovery.controller';
import { resolveEdgeClientAddress } from '../../config/trust-proxy';

const VISITOR_ID_HEADER = 'x-zt-visitor-id';
/** Opaque, server-computed hash — bounds length without assuming a specific algorithm upstream. */
const VISITOR_ID_RE = /^[a-f0-9]{16,128}$/i;

/**
 * Contract C11 (P1 remediation, CRITICAL) — elevates the per-IP public
 * discovery throttle to per-visitor for the Marketplace's server-rendered
 * reads, without raising the underlying numeric limits anywhere.
 *
 * THE BUG THIS FIXES: `PublicDiscoveryController`'s routes throttle on
 * `req.ip` (the base `ThrottlerGuard`'s default tracker), with no `trust
 * proxy` configured and no custom tracker. A server-rendered page (Next.js
 * SSR on Vercel) makes its discovery fetches FROM THE SERVER, so every real
 * visitor's request arrives at this API from the same small set of egress
 * IPs — collapsing every visitor into ONE shared 30/min bucket. The fix is
 * WHO the bucket is keyed to, not how big it is.
 *
 * MECHANISM: overrides only `getTracker()`. Elevation requires ALL of:
 *   1. The route is `PublicDiscoveryController` (a public discovery READ —
 *      this by construction never reaches `PublicBookingController`'s
 *      routes, which live in a different controller entirely; booking is
 *      never elevated).
 *   2. A presented `X-API-Key` authenticates via the EXISTING
 *      `ApiKeyService.authenticate()` as a PLATFORM-level key (`tenantId ===
 *      null`) carrying the `marketplace:discovery` scope.
 *   3. `X-ZT-Visitor-Id` is present and matches the expected hash shape.
 *
 * Any failure in 2 or 3 (unknown/inactive/expired/wrong-scope key, missing or
 * malformed visitor id, an authentication throw) falls through to the base
 * class's own `req.ip` tracker — the ORDINARY, unchanged path. There is no
 * partial-elevation state: either every condition holds, or none of the
 * elevation logic runs at all.
 *
 * DELIBERATELY NOT REUSED from `ApiKeyAuthGuard`: its per-key Redis rate
 * limiter (which fails OPEN on a Redis outage — wrong posture for a THROTTLE)
 * and its tenant-context push (a platform key carries no tenant; nothing here
 * should populate `TenantContextService`, and this guard never does). Only
 * `ApiKeyService.authenticate()` — the plain credential check — is reused.
 * `ELIGIBLE_CLINIC` and every route's `@Public()` status are untouched.
 *
 * NOT a second globally-registered named throttler profile: `generateKey()`
 * already hashes `<class>-<handler>-<throttlerName>-<tracker>`, so a
 * different TRACKER value alone gives every (route, visitor) pair its own
 * independent bucket under the existing 'default' profile — no route outside
 * `PublicDiscoveryController` is touched, and no route's numeric limit
 * changes. Registering a second profile in `ThrottlerModule.forRootAsync`
 * would apply it to EVERY controller in the app unless every one of them was
 * given an explicit `@SkipThrottle` — broader than this fix needs or wants.
 */
@Injectable()
export class MarketplaceThrottlerGuard extends ThrottlerGuard {
  private readonly marketplaceLogger = new Logger(MarketplaceThrottlerGuard.name);
  /** SEC-02: optional proof-of-edge secret; unset = the per-client path below is inert. */
  private readonly edgeToken: string | undefined;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
    @Optional() config?: ConfigService,
  ) {
    super(options, storage, reflector);
    this.edgeToken = config?.get<string>('EDGE_PROXY_TOKEN') || undefined;
  }

  protected async getTracker(req: Request, context?: ExecutionContext): Promise<string> {
    // The ordinary tracker. With `trust proxy` = 1 (TRUST_PROXY_HOPS) the base
    // class already resolves `req.ip` to the ALB-appended, unforgeable peer
    // address (SEC-02). Only a request that PROVES it came through the trusted
    // edge (X-ZT-Edge-Token) is keyed on the client address that edge forwarded
    // — see src/config/trust-proxy.ts for why nothing weaker is acceptable.
    const fallback = async () =>
      resolveEdgeClientAddress(req, this.edgeToken) ?? super.getTracker(req);

    if (!context || context.getClass() !== PublicDiscoveryController) {
      return fallback();
    }

    const presentedKey = this.extractKey(req);
    const visitorId = req.header(VISITOR_ID_HEADER);
    if (!presentedKey || !visitorId || !VISITOR_ID_RE.test(visitorId)) {
      return fallback();
    }

    try {
      const auth = await this.apiKeys.authenticate(presentedKey);
      if (auth.tenantId !== null) {
        // A tenant-scoped integration key presented here is not an error —
        // just not eligible for elevation (this is a discovery guard, not an
        // auth guard for the route).
        return fallback();
      }
      if (!auth.permissions.includes(INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY)) {
        return fallback();
      }
      return `mkt:${auth.keyId}:${this.normalizeVisitorId(visitorId)}`;
    } catch (err) {
      // Any authentication failure (unknown/inactive/expired key, malformed
      // input, a downstream throw) falls back to the unchanged per-IP path —
      // this guard must never itself become a way to fail a request closed.
      this.marketplaceLogger.debug(
        `Marketplace elevation declined, falling back to per-IP: ${(err as Error)?.message}`,
      );
      return fallback();
    }
  }

  /** Re-hashes the presented visitor id so the bucket key never stores the
   *  caller-supplied value verbatim in Redis/logs. */
  private normalizeVisitorId(visitorId: string): string {
    return createHash('sha256').update(visitorId).digest('hex').slice(0, 32);
  }

  private extractKey(req: Request): string | undefined {
    const headerKey = req.header('x-api-key');
    if (headerKey) return headerKey.trim();
    const authz = req.header('authorization');
    if (authz && /^ApiKey\s+/i.test(authz)) return authz.replace(/^ApiKey\s+/i, '').trim();
    return undefined;
  }
}
