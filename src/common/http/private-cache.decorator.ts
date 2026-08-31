import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';

export const PRIVATE_CACHE_KEY = 'private_cache_seconds';

@Injectable()
export class PrivateCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const seconds = this.reflector.getAllAndOverride<number | undefined>(
      PRIVATE_CACHE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (seconds && seconds > 0 && context.getType() === 'http') {
      const res = context.switchToHttp().getResponse<Response>();
      // Set on the way IN, before the handler runs. Express computes the ETag
      // and the conditional-GET 304 inside `res.send()`, and a 304 carries the
      // headers already on the response — so setting this after the fact would
      // omit it from exactly the responses that most need it.
      res.setHeader(
        'Cache-Control',
        `private, max-age=${seconds}, must-revalidate`,
      );
      // Same URL, different body per principal (permissions and branch scope
      // both change the payload). Without this a shared cache keyed on the URL
      // alone could hand one tenant's response to another.
      res.setHeader('Vary', 'Cookie');
    }

    return next.handle();
  }
}

/**
 * Let the BROWSER skip the request entirely for `seconds`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * These endpoints previously sent no `Cache-Control` at all, so every repeat —
 * a reload, a second tab, a back-navigation — was a full round trip. Express'
 * default weak ETag did produce 304s, but an ETag is computed inside
 * `res.send()`, i.e. AFTER the handler has already run every query it was
 * going to run. A 304 therefore saved bytes on the wire and nothing else: the
 * database was hit either way. `max-age` is the only mechanism that stops the
 * request before it is sent.
 *
 * ── WHY IT IS SAFE HERE ─────────────────────────────────────────────────────
 * • `private` — never stored by a shared proxy or CDN. This is per-tenant,
 *   per-permission data.
 * • `Vary: Cookie` — belt and braces on top of `private`, since the principal
 *   (and therefore the body) is determined by the auth cookie.
 * • `must-revalidate` — a stale copy is never served past `max-age`, even
 *   offline.
 * • The window is matched to the server-side analytics cache TTL, so it adds
 *   NO staleness that the tenant was not already exposed to: a request sent
 *   inside that window would have been answered from the same cached
 *   aggregation anyway.
 *
 * Apply ONLY to idempotent GETs whose payload is a tolerably-stale aggregate.
 * Never to a resource a mutation in the same session is expected to change
 * immediately — the browser would keep showing the pre-mutation body until
 * `max-age` elapsed.
 */
export function PrivateCache(seconds: number) {
  return applyDecorators(
    SetMetadata(PRIVATE_CACHE_KEY, seconds),
    UseInterceptors(PrivateCacheInterceptor),
  );
}
