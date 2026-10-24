/**
 * Guards the e2e harness itself (`createE2eApp`), because a flaw there fails OTHER suites at random.
 *
 * `supertest(server)` on a server that is NOT listening opens a listener for the first request and closes it
 * when that request finishes. Under `Promise.all([...N requests])` the first finisher tears the shared listener
 * down under the rest, which then fail with `read ECONNRESET`. That is timing-dependent — 0/1000 on a fast
 * desktop, 3/1000 in a 2-CPU Linux container — so it surfaced only on CI, in whichever burst test ran there
 * (public-discovery-throttle, public-booking-context). `createE2eApp` now listens up front.
 */
import request from 'supertest';

import { createE2eApp, type E2eApp } from './utils/whatsapp-e2e-app';

const API = '/api/v1';

describe('e2e harness — createE2eApp()', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 60_000);

  afterAll(async () => {
    await e2e.app.close();
  });

  it('hands out a server that is already listening, so supertest never owns (and closes) it', () => {
    expect(e2e.app.getHttpServer().listening).toBe(true);
  });

  it('serves a 100-request concurrent burst with no connection resets, and stays listening afterwards', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, () => request(e2e.app.getHttpServer()).get(`${API}/public/discovery/cities`)),
    );

    const failures = results.filter((r) => r.status === 'rejected').map((r) => String((r as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    for (const r of results) expect((r as PromiseFulfilledResult<request.Response>).value.status).toBe(200);
    expect(e2e.app.getHttpServer().listening).toBe(true);
  }, 60_000);
});
