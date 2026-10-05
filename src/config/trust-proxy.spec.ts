import express from 'express';
import request from 'supertest';
import { ThrottlerGuard } from '@nestjs/throttler';

import {
  applyTrustProxy,
  EDGE_TOKEN_HEADER,
  resolveEdgeClientAddress,
} from './trust-proxy';

/**
 * SEC-02. The first block runs REAL Express (so the claim "the last
 * X-Forwarded-For entry is the only one the ALB wrote" is exercised against the
 * framework, not assumed). A real ALB cannot be put in front of supertest, so
 * the socket peer is the loopback address and the header is supplied exactly as
 * the ALB would have produced it in `append` mode: caller-supplied entries
 * first, the ALB-observed peer last.
 */

const TOKEN = 'e'.repeat(40);

function appWith(hops: number) {
  const app = express();
  applyTrustProxy(
    {
      getHttpAdapter: () => ({ getInstance: () => app }),
    } as never,
    hops,
  );
  app.get('/ip', (req, res) =>
    res.json({
      ip: req.ip,
      ips: req.ips,
      edge: resolveEdgeClientAddress(req, TOKEN) ?? null,
    }),
  );
  return app;
}

describe('trust proxy hop count (SEC-02)', () => {
  it('hops=0 keeps the legacy behaviour: the socket peer, headers ignored', async () => {
    const res = await request(appWith(0)).get('/ip').set('X-Forwarded-For', '198.51.100.9');
    expect(res.body.ip).toMatch(/127\.0\.0\.1$/);
    expect(res.body.ips).toEqual([]);
  });

  it('hops=1 resolves req.ip to the LAST entry — the one the ALB appended', async () => {
    const res = await request(appWith(1)).get('/ip').set('X-Forwarded-For', '198.51.100.9');
    expect(res.body.ip).toBe('198.51.100.9');
  });

  it('hops=1 cannot be spoofed by entries the caller put to the left', async () => {
    // attacker sends "1.1.1.1, 2.2.2.2"; the ALB appends the attacker's real address.
    const res = await request(appWith(1))
      .get('/ip')
      .set('X-Forwarded-For', '1.1.1.1, 2.2.2.2, 203.0.113.77');
    expect(res.body.ip).toBe('203.0.113.77');
    expect(res.body.ips[0]).toBe('203.0.113.77');
  });

  it('falls back to the socket peer when no header is present (health checks, local calls)', async () => {
    const res = await request(appWith(1)).get('/ip');
    expect(res.body.ip).toMatch(/127\.0\.0\.1$/);
  });

  it('refuses a hop count that would trust a caller-controlled entry', () => {
    const app = { getHttpAdapter: () => ({ getInstance: () => express() }) } as never;
    expect(() => applyTrustProxy(app, 2)).toThrow(/between 0 and 1/);
    expect(() => applyTrustProxy(app, -1)).toThrow(/between 0 and 1/);
    expect(() => applyTrustProxy(app, 1.5)).toThrow(/between 0 and 1/);
  });

  it('the base throttler tracker is req.ip, i.e. the resolved (unforgeable) address', async () => {
    // @nestjs/throttler 6.5: `getTracker(req) { return req.ip }` — pinned here so an
    // upgrade that changes it (e.g. to req.ips[0]) is noticed.
    const getTracker = (ThrottlerGuard.prototype as any).getTracker as (r: unknown) => Promise<string>;
    await expect(getTracker({ ip: '203.0.113.77', ips: ['1.1.1.1'] })).resolves.toBe('203.0.113.77');
  });
});

describe('resolveEdgeClientAddress (opt-in, proof-based per-user key)', () => {
  const req = (headers: Record<string, string | string[]>, ip: string) =>
    ({ headers, ip }) as never;

  it('is inert when no token is configured, even if a header is presented', () => {
    expect(
      resolveEdgeClientAddress(
        req({ [EDGE_TOKEN_HEADER]: TOKEN, 'x-forwarded-for': '198.51.100.1, 76.76.21.1' }, '76.76.21.1'),
        undefined,
      ),
    ).toBeUndefined();
  });

  it('returns the client the edge forwarded when the token matches and the chain is as expected', () => {
    expect(
      resolveEdgeClientAddress(
        req({ [EDGE_TOKEN_HEADER]: TOKEN, 'x-forwarded-for': '198.51.100.1, 76.76.21.1' }, '76.76.21.1'),
        TOKEN,
      ),
    ).toBe('198.51.100.1');
  });

  it('ignores everything to the left of the client entry (only the entry beside the ALB one is read)', () => {
    expect(
      resolveEdgeClientAddress(
        req(
          { [EDGE_TOKEN_HEADER]: TOKEN, 'x-forwarded-for': '9.9.9.9, 198.51.100.1, 76.76.21.1' },
          '76.76.21.1',
        ),
        TOKEN,
      ),
    ).toBe('198.51.100.1');
  });

  it.each([
    ['missing token header', {}],
    ['wrong token', { [EDGE_TOKEN_HEADER]: 'f'.repeat(40) }],
    ['token of a different length', { [EDGE_TOKEN_HEADER]: 'short' }],
  ])('is rejected on %s', (_label, extra) => {
    expect(
      resolveEdgeClientAddress(
        req({ ...extra, 'x-forwarded-for': '198.51.100.1, 76.76.21.1' } as never, '76.76.21.1'),
        TOKEN,
      ),
    ).toBeUndefined();
  });

  it.each([
    ['a single-entry chain (no edge hop to read)', '76.76.21.1', '76.76.21.1'],
    ['the last entry is not the address Express resolved (no ALB / hops misconfigured)', '198.51.100.1, 76.76.21.1', '10.0.0.5'],
    ['the client entry is not an IP', 'not-an-ip, 76.76.21.1', '76.76.21.1'],
    ['the client entry is empty', ', 76.76.21.1', '76.76.21.1'],
  ])('falls back (undefined) when %s', (_label, xff, ip) => {
    expect(
      resolveEdgeClientAddress(
        req({ [EDGE_TOKEN_HEADER]: TOKEN, 'x-forwarded-for': xff }, ip),
        TOKEN,
      ),
    ).toBeUndefined();
  });

  it('a request without the token cannot use the edge path through a real Express app', async () => {
    const res = await request(appWith(1))
      .get('/ip')
      .set('X-Forwarded-For', '1.1.1.1, 203.0.113.77');
    expect(res.body.edge).toBeNull();
    expect(res.body.ip).toBe('203.0.113.77');
  });

  it('with the token, through a real Express app, the forwarded client is returned', async () => {
    const res = await request(appWith(1))
      .get('/ip')
      .set(EDGE_TOKEN_HEADER, TOKEN)
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.77');
    expect(res.body.edge).toBe('198.51.100.1');
  });
});
