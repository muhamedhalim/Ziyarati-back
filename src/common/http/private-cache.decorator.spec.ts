/**
 * `@PrivateCache(n)` — the only mechanism that stops a repeat request being
 * SENT.
 *
 * Express's default weak ETag already produced 304s for these endpoints, and a
 * 304 is worth almost nothing here: `res.send()` computes the ETag, so by the
 * time the comparison happens the handler has already run every query it was
 * going to run. The database is hit either way; only bytes on the wire are
 * saved. `Cache-Control: max-age` is what makes the browser not ask at all.
 *
 * The headers are therefore load-bearing, and each assertion below guards one
 * way of getting them wrong.
 */
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';

import {
  PRIVATE_CACHE_KEY,
  PrivateCacheInterceptor,
} from './private-cache.decorator';

function makeContext(headers: Record<string, string>) {
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  };
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getResponse: () => res }),
  } as never;
}

function run(seconds: number | undefined, type: 'http' | 'ws' = 'http') {
  const headers: Record<string, string> = {};
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === PRIVATE_CACHE_KEY ? seconds : undefined,
  } as unknown as Reflector;

  const ctx = makeContext(headers);
  (ctx as { getType: () => string }).getType = () => type;

  const interceptor = new PrivateCacheInterceptor(reflector);
  const handled = interceptor.intercept(ctx, {
    handle: () => of({ ok: true }),
  });
  return { headers, handled };
}

describe('PrivateCacheInterceptor', () => {
  it('sets a private, revalidating max-age', async () => {
    const { headers, handled } = run(30);
    await firstValueFrom(handled);

    expect(headers['Cache-Control']).toBe(
      'private, max-age=30, must-revalidate',
    );
  });

  it('marks the response as private — never storable by a shared cache', () => {
    const { headers } = run(30);

    // These payloads are per-tenant AND per-permission. A `public` directive,
    // or no directive at all with a heuristic-caching proxy in front, could
    // serve one clinic's numbers to another.
    expect(headers['Cache-Control']).toContain('private');
    expect(headers['Cache-Control']).not.toContain('public');
  });

  it('varies on Cookie, because the principal decides the body', () => {
    const { headers } = run(30);

    expect(headers['Vary']).toBe('Cookie');
  });

  it('forbids serving a stale copy past max-age', () => {
    const { headers } = run(30);

    expect(headers['Cache-Control']).toContain('must-revalidate');
  });

  it('sets the header BEFORE the handler resolves, so a 304 still carries it', () => {
    // Express writes a 304 from the headers already on the response. Setting
    // Cache-Control after the body resolved would omit it from exactly the
    // responses a conditional GET produces.
    const { headers } = run(30);

    expect(headers['Cache-Control']).toBeDefined();
  });

  it('does nothing on a route that did not ask for it', async () => {
    const { headers, handled } = run(undefined);
    await firstValueFrom(handled);

    expect(headers).toEqual({});
  });

  it('does nothing for a zero or negative window', () => {
    expect(run(0).headers).toEqual({});
    expect(run(-1).headers).toEqual({});
  });

  it('does nothing outside an HTTP context', () => {
    expect(run(30, 'ws').headers).toEqual({});
  });
});
