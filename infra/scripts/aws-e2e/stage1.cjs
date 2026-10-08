// Stage 1: auth lifecycle + two throwaway clinics (A, B). State saved to state.json for later stages.
const fs = require('fs');
const { init, Actor, check, results } = require('./lib.cjs');
(async () => {
  const ip = await init(); console.log('ALB ip', ip);
  const ts = Date.now().toString(36);
  const mk = (tag) => ({
    email: `success+zze2e${tag}${ts}@simulator.amazonses.com`,
    password: 'E2e-Test!' + ts + tag,
    fullName: `ZZ E2E Owner ${tag.toUpperCase()}`,
    clinicName: `ZZ E2E Clinic ${tag.toUpperCase()} ${ts}`,
    slug: `zz-e2e-${tag}-${ts}`,
    commercialRegistrationNumber: `ZZE2E${tag.toUpperCase()}${ts}`.slice(0, 30),
    locale: 'en',
  });
  const A = new Actor('A'), B = new Actor('B');
  const dtoA = mk('a'), dtoB = mk('b');

  // --- unauthenticated baseline
  let r = await A.call('GET', '/auth/me', { auth: false });
  check('unauthenticated /auth/me -> 401', r.status === 401, `status ${r.status}`);

  // --- register owners (public, creates tenant + owner, sets cookies)
  r = await A.call('POST', '/auth/register-owner', { json: dtoA, auth: false });
  check('register-owner A -> 201 + auth cookies', r.status === 201 && !!A.jar.access_token && !!A.jar.refresh_token && !!A.jar.csrf_token, `status ${r.status} cookies=${Object.keys(A.jar).join(',')}`);
  if (r.status !== 201) { console.log(JSON.stringify(r.data).slice(0, 600)); process.exit(2); }
  r = await B.call('POST', '/auth/register-owner', { json: dtoB, auth: false });
  check('register-owner B -> 201', r.status === 201, `status ${r.status}`);

  const flags = (c) => c.map(String).filter((s) => /^(access_token|refresh_token|csrf_token)=/.test(s));
  r = await A.call('POST', '/auth/register-owner', { json: dtoA, auth: false });
  check('duplicate register-owner -> 409', r.status === 409, `status ${r.status}`);

  // cookie attributes (Secure / HttpOnly / domain) as the browser would see them
  const probe = new Actor('probe');
  r = await probe.call('POST', '/auth/login', { json: { email: dtoA.email, password: dtoA.password }, auth: false });
  const sc = r.headers['set-cookie'] || [];
  const acc = sc.find((c) => c.startsWith('access_token=')) || '';
  check('login -> 200/201', [200, 201].includes(r.status), `status ${r.status}`);
  check('access_token cookie HttpOnly+Secure+SameSite=Lax', /HttpOnly/i.test(acc) && /Secure/i.test(acc) && /SameSite=Lax/i.test(acc), acc.replace(/=[^;]+/, '=<redacted>'));
  const csrf = sc.find((c) => c.startsWith('csrf_token=')) || '';
  check('csrf_token cookie readable (not HttpOnly)', !!csrf && !/HttpOnly/i.test(csrf));

  r = await probe.call('POST', '/auth/login', { json: { email: dtoA.email, password: 'wrong-password-123' }, auth: false });
  check('login with wrong password -> 401', r.status === 401, `status ${r.status}`);

  r = await A.call('GET', '/auth/me');
  check('/auth/me (cookie) -> 200 with tenant+role', r.status === 200, JSON.stringify(r.data).slice(0, 300));
  const meA = r.data.user || r.data;
  r = await B.call('GET', '/auth/me'); const meB = r.data.user || r.data;

  // CSRF: state-changing request with cookie but WITHOUT the header must be rejected
  const noCsrf = await new Actor('x'); noCsrf.jar = { ...A.jar }; delete noCsrf.jar.csrf_token;
  r = await noCsrf.call('POST', '/auth/logout-all');
  check('cookie-authed POST without CSRF header -> 403', r.status === 403, `status ${r.status}`);

  // refresh rotation
  const oldRefresh = A.jar.refresh_token;
  r = await A.call('POST', '/auth/refresh');
  check('refresh -> 200/201 and rotates refresh token', [200, 201].includes(r.status) && A.jar.refresh_token && A.jar.refresh_token !== oldRefresh, `status ${r.status}`);
  const replay = new Actor('replay'); replay.jar = { refresh_token: oldRefresh, csrf_token: A.jar.csrf_token };
  r = await replay.call('POST', '/auth/refresh');
  check('replayed (rotated-out) refresh token -> 401', r.status === 401, `status ${r.status}`);

  fs.writeFileSync('state.json', JSON.stringify({ ts, dtoA, dtoB, jarA: A.jar, jarB: B.jar, meA, meB }, null, 2));
  console.log('\nmeA keys:', Object.keys(meA).join(','), '\ntenantA:', meA.tenantId || (meA.tenant && meA.tenant.id), ' tenantB:', meB.tenantId || (meB.tenant && meB.tenant.id));
  const fails = results.filter((x) => !x.ok).length; console.log(`\nSTAGE1: ${results.length - fails}/${results.length} passed`); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
