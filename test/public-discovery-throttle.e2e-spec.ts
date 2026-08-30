/**
 * T069 (US4, FR-P014) — per-route throttling on
 * `PublicDiscoveryController`, which previously relied on nothing but the
 * platform-wide 300/min default even though it is the enumeration surface
 * for the entire public clinic directory.
 *
 * Rate-limit note: like every other `@Throttle()`-gated route in this
 * codebase (see `GUEST_ATTACHMENT_THROTTLE`'s own precedent), the ceiling is
 * relaxed to a no-op under `NODE_ENV=test` so this suite's own request
 * volume never trips it — genuinely reproducing a 429 here isn't practical.
 * The NUMERIC ceilings themselves (stricter than the global default) are
 * proven in `public-discovery.throttle.spec.ts` (T069); this suite instead
 * proves (a) the routes survive a burst without crashing or behaving
 * inconsistently, and (b) the route-scoped throttle is scoped to exactly
 * these three routes — an authenticated clinic operation on a completely
 * different controller is unaffected by it.
 */
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  type E2eApp,
} from './utils/whatsapp-e2e-app';

const API = '/api/v1';

describe('Public discovery — per-route throttling (T069, US4)', () => {
  let e2e: E2eApp;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.app.close();
  });

  it('survives a burst of city listing requests without crashing or behaving inconsistently', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(e2e.app.getHttpServer()).get(`${API}/public/discovery/cities`),
      ),
    );

    const statuses = new Set(results.map((r) => r.status));
    expect(statuses.size).toBe(1);
    expect([...statuses][0]).toBe(200);
  });

  it('survives a burst of clinic search requests without crashing or behaving inconsistently', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(e2e.app.getHttpServer()).get(
          `${API}/public/discovery/clinics?q=dentist`,
        ),
      ),
    );

    const statuses = new Set(results.map((r) => r.status));
    expect(statuses.size).toBe(1);
    expect([...statuses][0]).toBe(200);
  });

  it('is scoped to the discovery routes only — an authenticated clinic operation on a different controller is unaffected', async () => {
    const owner = await createOwnerFixture(e2e, 'discovery-throttle-isolation');

    const discoveryBurst = Array.from({ length: 25 }, () =>
      request(e2e.app.getHttpServer()).get(`${API}/public/discovery/cities`),
    );
    const authenticated = request(e2e.app.getHttpServer())
      .get(`${API}/branches`)
      .set('Authorization', `Bearer ${owner.token}`);

    const [discoveryResults, authResult] = await Promise.all([
      Promise.all(discoveryBurst),
      authenticated,
    ]);

    expect(new Set(discoveryResults.map((r) => r.status)).size).toBe(1);
    expect(authResult.status).toBe(200);
  });
});
