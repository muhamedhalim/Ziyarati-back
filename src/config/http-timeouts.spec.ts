import { createServer } from 'node:http';

import {
  applyHttpTimeouts,
  DEFAULT_HTTP_TIMEOUTS,
  resolveHttpTimeouts,
} from './http-timeouts';

/** RL-12 — see http-timeouts.ts for why each bound is what it is. */
describe('HTTP server timeouts (RL-12)', () => {
  const ALB_IDLE_TIMEOUT_MS = 120_000; // infra/terraform/modules/alb/variables.tf

  it('defaults keep the socket alive longer than the ALB idle timeout', () => {
    const t = resolveHttpTimeouts({});
    expect(t).toEqual(DEFAULT_HTTP_TIMEOUTS);
    expect(t.keepAliveTimeoutMs).toBeGreaterThan(ALB_IDLE_TIMEOUT_MS);
  });

  it('defaults bound a slow request well below Node’s 300 s', () => {
    expect(resolveHttpTimeouts({}).requestTimeoutMs).toBeLessThan(300_000);
  });

  it('always keeps keepAlive < headers ≤ request, whatever is configured', () => {
    const t = resolveHttpTimeouts({
      HTTP_KEEP_ALIVE_TIMEOUT_MS: '200000',
      HTTP_HEADERS_TIMEOUT_MS: '10000',
      HTTP_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(t.headersTimeoutMs).toBeGreaterThan(t.keepAliveTimeoutMs);
    expect(t.requestTimeoutMs).toBeGreaterThanOrEqual(t.headersTimeoutMs);
  });

  it('ignores invalid values and falls back to the defaults', () => {
    expect(
      resolveHttpTimeouts({
        HTTP_KEEP_ALIVE_TIMEOUT_MS: 'abc',
        HTTP_REQUEST_TIMEOUT_MS: '-1',
      }),
    ).toEqual(DEFAULT_HTTP_TIMEOUTS);
  });

  it('applies the values to a real Node server', () => {
    const server = createServer();
    applyHttpTimeouts(server, DEFAULT_HTTP_TIMEOUTS);
    expect(server.keepAliveTimeout).toBe(125_000);
    expect(server.headersTimeout).toBe(130_000);
    expect(server.requestTimeout).toBe(135_000);
  });
});
