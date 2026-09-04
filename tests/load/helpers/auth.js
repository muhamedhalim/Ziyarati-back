/**
 * Authentication + per-VU session context.
 *
 * WHY THIS SHAPE:
 *  - `POST /auth/login` costs ~430ms because AuthService hashes with bcrypt at
 *    cost factor 12 (measured, and by design). Logging in per-iteration would
 *    make every scenario a bcrypt benchmark. So we log in ONCE in setup() and
 *    hand every VU a ready session.
 *  - Login returns `{user}` ONLY — tokens are never in the body. They arrive as
 *    httpOnly cookies, so we harvest them from the cookie jar.
 *  - Refresh rotation is single-use (a Postgres conditional UPDATE). Sharing one
 *    refresh token across VUs produces 401s and eventually revokes the whole
 *    token family. We therefore never refresh mid-test; access tokens live 15m,
 *    which comfortably outlasts every scenario except the soak (see README).
 *  - CSRF is double-submit: non-GET requests must send `X-CSRF-Token` equal to
 *    the `csrf_token` cookie.
 *
 * No credential is ever logged, and no token is written to stdout.
 */
import http from 'k6/http';
import { fail } from 'k6';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:3001';
const PASSWORD = __ENV.TEST_PASSWORD;

/** The 5 seeded perf tenants x 3 roles. Emails are non-secret test fixtures. */
export function accountList() {
  const domain = __ENV.TEST_EMAIL_DOMAIN || 't1.local.test';
  const tenants = Number(__ENV.TEST_TENANTS || 5);
  const roles = (__ENV.TEST_ROLES || 'owner,receptionist').split(',');
  const out = [];
  for (let t = 0; t < tenants; t++) {
    for (const role of roles) {
      out.push({ email: `perf.${role}.t${t}@${domain}`, role, tenantIndex: t });
    }
  }
  return out;
}

/** Logs one account in and returns its session, or null if it cannot. */
export function login(account) {
  const res = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: account.email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth/login' } },
  );
  if (res.status !== 200) {
    // Never echo the response body: it can carry account detail.
    return null;
  }
  const jar = http.cookieJar().cookiesForURL(`${BASE}/api/v1/auth/login`);
  const body = res.json();
  return {
    email: account.email,
    role: account.role,
    tenantIndex: account.tenantIndex,
    tenantId: body.user.tenantId,
    userId: body.user.id,
    // Permissions ride on the login/me payload. Flows gate on these so a
    // receptionist does not spend the whole run collecting 403s from
    // owner-only endpoints (e.g. /activity requires `audit.read`).
    permissions: body.user.permissions || [],
    access: jar.access_token ? jar.access_token[0] : null,
    csrf: jar.csrf_token ? jar.csrf_token[0] : null,
  };
}

/** Request params for an authenticated GET. */
export function authGet(session, extraTags) {
  return {
    headers: { Cookie: `access_token=${session.access}` },
    tags: Object.assign({}, extraTags),
  };
}

/** Request params for an authenticated write (adds the double-submit CSRF pair). */
export function authWrite(session, extraTags) {
  return {
    headers: {
      Cookie: `access_token=${session.access}; csrf_token=${session.csrf}`,
      'X-CSRF-Token': session.csrf,
      'Content-Type': 'application/json',
    },
    tags: Object.assign({}, extraTags),
  };
}

/**
 * Discovers the per-tenant resource ids each scenario needs, through the API
 * (never the database) so the fixture and the suite cannot drift apart.
 */
export function loadTenantContext(session) {
  const p = authGet(session, { name: 'setup/context' });

  // BATCHED, not sequential. At TEST_TENANTS=50 this runs for 100 sessions, and
  // 6-7 serial round trips each pushed setup() past k6's 60s setupTimeout — the
  // run then dies in setup with no results at all. Two batched waves instead of
  // ~7 serial requests keeps the whole fan-out well inside the budget.
  const wave = http.batch([
    ['GET', `${BASE}/api/v1/branches`, null, p],
    ['GET', `${BASE}/api/v1/staff?page=1&limit=20`, null, p],
    ['GET', `${BASE}/api/v1/crm/customers?page=1&limit=20`, null, p],
    ['GET', `${BASE}/api/v1/services/lookup`, null, p],
  ]);
  const [branches, staff, customers, services] = wave;

  const pick = (res, path) => {
    if (!res || res.status !== 200) return [];
    let b;
    try { b = res.json(); } catch (e) { return []; }
    const arr = path ? b[path] : b;
    return Array.isArray(arr) ? arr.map((x) => x.id) : [];
  };

  const branchIds = pick(branches, null);

  // A staff member only works at their OWN branch. Booking a staff member at a
  // branch they are not scheduled at is rejected with 409 "does not work at the
  // selected branch", and the availability engine reports them unbookable — so
  // pairing them arbitrarily would turn both scenarios into a 409 generator that
  // measures nothing. Resolve the real membership per branch instead.
  const pairs = [];
  if (branchIds.length) {
    const perBranch = http.batch(
      branchIds.map((branchId) => [
        'GET', `${BASE}/api/v1/staff?branchId=${branchId}&limit=50`, null, p,
      ]),
    );
    for (let i = 0; i < branchIds.length; i++) {
      const ids = pick(perBranch[i], 'data');
      if (ids.length) pairs.push({ branchId: branchIds[i], staffIds: ids });
    }
  }

  return Object.assign({}, session, {
    branchIds,
    pairs,
    staffIds: pick(staff, 'data'),
    customerIds: pick(customers, 'data'),
    serviceIds: pick(services, null),
  });
}

/** True when the session's principal holds every listed permission. */
export function can(session, ...perms) {
  return perms.every((x) => session.permissions.indexOf(x) !== -1);
}

/** Picks a {branchId, staffId} that are genuinely paired. */
export function pickPair(session, seed) {
  if (!session.pairs || !session.pairs.length) return null;
  const pair = session.pairs[seed % session.pairs.length];
  return {
    branchId: pair.branchId,
    staffId: pair.staffIds[seed % pair.staffIds.length],
  };
}

/** setup() helper: log every account in and attach its tenant context. */
export function buildSessions() {
  if (!PASSWORD) fail('TEST_PASSWORD env var is required (never hardcode it)');
  const sessions = [];
  for (const acct of accountList()) {
    const s = login(acct);
    if (s && s.access) sessions.push(loadTenantContext(s));
  }
  if (sessions.length === 0) fail('no test account could authenticate — check TEST_PASSWORD / fixture');

  // Per-run slot band. Without it, a second run reuses the first run's slots and
  // every booking loses to the gist exclusion constraint — the write scenario
  // would report a 409 storm that is an artefact of not having cleaned up, not a
  // property of the system. Minute-resolution, so two runs a minute apart never
  // collide; cleanup.sql still removes every marked row regardless.
  const runSeed = Math.floor(Date.now() / 60000) % 100000;
  for (const s of sessions) s.runSeed = runSeed;
  return sessions;
}

/**
 * Deterministically assigns a VU to one session so tenant context is stable.
 *
 * TENANT_SKEW (0..1) models the SAME-TENANT HOTSPOT: that fraction of VUs is
 * pinned to sessions[0]'s tenant while the rest spread evenly. Real clinics are
 * not uniformly busy, and several costs here are per-tenant rather than global —
 * the usage-counter row a booking locks, the 60s Redis dashboard cache key, and
 * every tenant-scoped index prefix. A perfectly uniform spread hides all three.
 * The skew decision is a pure function of the VU id, so a run is reproducible
 * and the same VUs are the hot ones every time.
 */
const TENANT_SKEW = Number(__ENV.TENANT_SKEW || 0);

export function sessionFor(sessions, vu) {
  if (TENANT_SKEW > 0) {
    const h = ((vu * 2654435761) >>> 0) % 1000;
    if (h < TENANT_SKEW * 1000) return sessions[0];
  }
  return sessions[(vu - 1) % sessions.length];
}

/** A session guaranteed NOT to share `session`'s tenant — for isolation probes. */
export function otherTenantSession(sessions, session) {
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].tenantId !== session.tenantId) return sessions[i];
  }
  return null;
}

export { BASE };
