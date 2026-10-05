/**
 * Authentication as a LOAD CLASS (it never was one before this campaign).
 *
 * Cost model: every login is one native-bcrypt (cost 12) compare + 2 JWT signs +
 * 1 refresh_tokens INSERT + a Redis lockout read. Refresh has NO bcrypt (one
 * conditional UPDATE + principal join + INSERT) and is strictly one-time-use per
 * session family, so each VU owns its own cookie jar and never shares a refresh
 * token. Logout is one UPDATE.
 *
 * LOCKOUT SAFETY. The lockout is keyed by the normalised EMAIL (5 failures / 900 s)
 * and is NOT relaxed by NODE_ENV=test. Therefore:
 *  - successful-login herds can reuse an account freely (success clears the counter);
 *  - rejected-login probes use DEDICATED accounts (pack-auth-bad.json), one account
 *    per VU, at most 4 wrong attempts per account per run (never the 5th), so they
 *    can never lock a real fixture account;
 *  - the deliberate lockout probe (authLockoutProbe) uses its OWN accounts
 *    (pack-auth-lock.json) and expects the 5th/6th attempt to be 429.
 *
 * pack-auth.json       [{ email }]   loginable users;  password = LT_LOGIN_PASSWORD (env, lab only)
 * pack-auth-bad.json   [{ email }]   one per VU        (known-wrong password probes)
 * pack-auth-lock.json  [{ email }]   one per VU        (lockout probe, burns the account)
 */
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE } from '../helpers/auth.js';
import { observe, authLoginOk, authLoginRejected, authLockout429, refreshOk, refreshRejected } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';
import { pack } from '../helpers/sessions.js';

const USERS = pack('auth');
const BAD = pack('auth-bad');
const LOCK = pack('auth-lock');
const PASSWORD = __ENV.LT_LOGIN_PASSWORD || '';
const JSON_H = { 'Content-Type': 'application/json' };
const EXPECT_AUTH = http.expectedStatuses({ min: 200, max: 299 }, 401, 429);

function csrfFromJar() {
  const c = http.cookieJar().cookiesForURL(`${BASE}/api/v1/auth/refresh`);
  return c.csrf_token ? c.csrf_token[0] : null;
}

function loginRequest(email, password, step, tag) {
  return http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email, password }), {
    headers: JSON_H, tags: { step, name: tag || 'auth/login' }, responseCallback: EXPECT_AUTH,
  });
}

/** A real login. Returns true on 200. */
export function login(step) {
  if (!USERS.length || !PASSWORD) return false;
  const u = USERS[(__VU * 7919 + (__ITER || 0) * 31) % USERS.length];
  const res = loginRequest(u.email, PASSWORD, step);
  observe(res, 'auth:login', step);
  if (res.status === 200) { authLoginOk.add(1, { step }); return true; }
  if (res.status === 429) authLockout429.add(1, { step });
  else authLoginRejected.add(1, { step, status: String(res.status) });
  businessErrors.add(true, { step });
  return false;
}

export function me(step) {
  const res = http.get(`${BASE}/api/v1/auth/me`, { tags: { step, name: 'auth/me' } });
  observe(res, 'auth:me', step);
  businessErrors.add(res.status !== 200, { step });
  return res;
}

/** Refresh with this VU's own cookie jar. Rotation is one-time-use. */
export function refresh(step) {
  const csrf = csrfFromJar();
  if (!csrf) return null;
  const res = http.post(`${BASE}/api/v1/auth/refresh`, null, {
    headers: { 'X-CSRF-Token': csrf }, tags: { step, name: 'auth/refresh' }, responseCallback: EXPECT_AUTH,
  });
  observe(res, 'auth:refresh', step);
  if (res.status === 200) refreshOk.add(1, { step });
  else { refreshRejected.add(1, { step, status: String(res.status) }); businessErrors.add(true, { step }); }
  return res;
}

export function logout(step) {
  const csrf = csrfFromJar();
  const res = http.post(`${BASE}/api/v1/auth/logout`, null, {
    headers: csrf ? { 'X-CSRF-Token': csrf } : {}, tags: { step, name: 'auth/logout' },
  });
  observe(res, 'auth:logout', step);
  return res;
}

/** A full session lifetime compressed: login, me, N refreshes, logout. */
export function sessionLifecycle(step, refreshes, gapSeconds) {
  if (!login(step)) return false;
  me(step);
  for (let i = 0; i < (refreshes || 2); i++) {
    sleep(gapSeconds || 1);
    const r = refresh(step);
    if (!r || r.status !== 200) return false;
  }
  logout(step);
  return true;
}

/** Wrong-password probe: <= 4 attempts per dedicated account per run, never the 5th. */
export function badLoginProbe(step) {
  if (!BAD.length || (__ITER || 0) >= 4) return null;
  const u = BAD[(__VU - 1) % BAD.length];
  const res = loginRequest(u.email, `${PASSWORD}-definitely-wrong`, step, 'auth/login-bad');
  observe(res, 'auth:login:bad', step);
  businessErrors.add(res.status !== 401, { step }); // 401 is the CORRECT answer
  return res;
}

/** Deliberate lockout: attempts 1-5 fail with 401, then 429. Burns its dedicated account. */
export function lockoutProbe(step) {
  if (!LOCK.length) return null;
  const u = LOCK[(__VU - 1) % LOCK.length];
  let last = null;
  for (let i = 0; i < 7; i++) {
    last = loginRequest(u.email, `${PASSWORD}-wrong-${i}`, step, 'auth/login-lockout');
    observe(last, 'auth:login:lockout', step);
    if (last.status === 429) authLockout429.add(1, { step });
  }
  businessErrors.add(last.status !== 429, { step });
  return last;
}
