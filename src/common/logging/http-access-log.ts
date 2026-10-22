import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getClientAddress } from '../../config/trust-proxy';
import { isIP } from 'node:net';

import { ROLE } from '../../rbac/rbac.constants';
import { LOG_EVENT } from './log-events';

/**
 * One access-log line per HTTP request, plus the existing Prometheus duration
 * histogram (PERF-BE-002), from ONE middleware registered before every other
 * middleware and guard — so guard rejections (401/403/429/503) are included.
 *
 * Only an explicit allow-list of request metadata is ever read: method, the
 * matched ROUTE TEMPLATE (never the raw URL — no ids, no query string), status,
 * duration, response size, and the principal that authentication put on
 * `req.user`. Headers, cookies, bodies and query strings are never touched.
 *
 * Levels: routine health/metrics probes are `debug` (dropped at the production
 * default `info`) unless they fail; everything else is `info`. A failed request
 * is ALSO described by `AllExceptionsFilter` (which owns the error and its
 * stack) — this line is the per-request record, not a second error.
 */
export interface HttpMetricsRecorder {
  recordHttpRequest(
    method: string,
    statusCode: number,
    durationSeconds: number,
  ): void;
}

export type ClientIpMode = 'full' | 'truncated' | 'off';

const NOISE_PATH_RE =
  /^\/(?:api\/v\d+\/)?(?:health|system\/health|metrics)(?:\/|$)|^\/(?:favicon\.ico)?$/i;
const RAW_ROUTES: Record<string, string> = {
  '/api/v1/health': '/api/v1/health',
};

interface Principal {
  id?: string;
  tenantId?: string | null;
  roles?: string[];
}

export function createHttpObservabilityMiddleware(options: {
  metrics: HttpMetricsRecorder;
  clientIpMode?: ClientIpMode;
  logger?: Pick<Logger, 'log' | 'debug'>;
}) {
  const logger = options.logger ?? new Logger('HttpAccess');
  const ipMode = options.clientIpMode ?? 'truncated';

  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    let done = false;

    const finish = (aborted: boolean): void => {
      if (done) return;
      done = true;
      const durationNs = process.hrtime.bigint() - startedAt;
      if (!aborted) {
        options.metrics.recordHttpRequest(
          req.method,
          res.statusCode,
          Number(durationNs) / 1e9,
        );
      }
      try {
        writeAccessLog(
          logger,
          req,
          res,
          Number(durationNs) / 1e6,
          aborted,
          ipMode,
        );
      } catch {
        // access logging is never allowed to affect the response
      }
    };

    res.on('finish', () => finish(false));
    res.on('close', () => finish(!res.writableFinished));
    next();
  };
}

function writeAccessLog(
  logger: Pick<Logger, 'log' | 'debug'>,
  req: Request,
  res: Response,
  durationMs: number,
  aborted: boolean,
  ipMode: ClientIpMode,
): void {
  const status = aborted ? 499 : res.statusCode;
  const route = routeTemplate(req);
  const principal = req.user as Principal | undefined;
  const duration_ms = Math.round(durationMs * 100) / 100;

  const record: Record<string, unknown> = {
    event: LOG_EVENT.HTTP_REQUEST_COMPLETED,
    message: `${req.method} ${route} ${status} ${duration_ms}ms`,
    method: req.method,
    route,
    status,
    duration_ms,
  };
  if (req.requestId) record.request_id = req.requestId;
  if (principal?.id) record.user_id = principal.id;
  if (principal?.tenantId) record.tenant_id = principal.tenantId;
  if (
    principal &&
    principal.tenantId === null &&
    principal.roles?.includes(ROLE.SUPER_ADMIN)
  ) {
    record.platform_admin = true;
  }
  const bytes = Number(res.getHeader('content-length'));
  if (Number.isFinite(bytes) && bytes >= 0) record.response_bytes = bytes;
  const ip = formatClientIp(getClientAddress(req), ipMode);
  if (ip) record.client_ip = ip;
  if (aborted) record.aborted = true;

  const isNoise = NOISE_PATH_RE.test(req.path ?? '') && status < 500;
  if (isNoise) logger.debug(record);
  else logger.log(record);
}

/**
 * The Express-matched pattern (e.g. `/api/v1/appointments/:id`) — the same
 * value `TenantContextInterceptor` and `ApiLoggingInterceptor` use. A request
 * that matched no route (404, or rejected before routing) is `unmatched`, so a
 * scan of random paths can never create unbounded distinct values.
 */
export function routeTemplate(req: Request): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    return `${req.baseUrl ?? ''}${routePath}`.slice(0, 200);
  }
  const base = req.baseUrl ?? '';
  return RAW_ROUTES[base] ?? 'unmatched';
}

/**
 * `req.ip` already honours `TRUST_PROXY_HOPS` (a hop count, never `true`), so
 * this never reads `X-Forwarded-For` itself. Anything that is not a literal IP
 * is dropped. `truncated` keeps the /24 (IPv4) or /48 (IPv6) network — enough
 * to see a burst from one network without retaining the exact address.
 */
export function formatClientIp(
  raw: string | undefined,
  mode: ClientIpMode,
): string | undefined {
  if (mode === 'off' || !raw) return undefined;
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  const family = isIP(ip);
  if (family === 0) return undefined;
  if (mode === 'full') return ip;
  if (family === 4) return ip.replace(/\.\d+$/, '.0');
  return `${expandIpv6(ip).slice(0, 3).join(':')}::/48`;
}

/** `2001:db8::1` → 8 groups; zone ids (`%eth0`) dropped. */
function expandIpv6(ip: string): string[] {
  const addr = ip.split('%')[0];
  const [head, tail] = addr.includes('::')
    ? addr.split('::')
    : [addr, undefined];
  const headGroups = head ? head.split(':') : [];
  if (tail === undefined) return headGroups;
  const tailGroups = tail ? tail.split(':') : [];
  const zeros = Array(
    Math.max(0, 8 - headGroups.length - tailGroups.length),
  ).fill('0');
  return [...headGroups, ...zeros, ...tailGroups];
}
