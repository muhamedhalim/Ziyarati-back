/**
 * AUTHENTICATION CONCURRENCY REGRESSION SUITE — container-backed, real Postgres
 * + Redis, real `AppModule`.
 *
 * POSTURE. These are SECURE REGRESSION TESTS. Every assertion states the
 * property the system must uphold, not the behaviour it happens to have. They
 * were converted from the documenting-current-behaviour audit suite once
 * AUTH-001 / AUTH-002 / AUTH-003 were fixed; each test names the defect it
 * guards so a regression is legible rather than just red. See
 * docs/AUTH_CONCURRENCY_GC_AUDIT.md.
 *
 * WHY E2E AND NOT UNIT TESTS. Concurrency cannot be certified from mocks — the
 * same argument `max-users-concurrency.e2e-spec.ts` (FND-007) and
 * `login-protection.e2e-spec.ts` (FND-008) already make in this repo. A mocked
 * repository serialises by construction, so a read-check-write window that is
 * wide open against real Postgres simply does not exist in a unit test. The fix
 * being guarded here IS a Postgres conditional UPDATE; only a real database can
 * prove it.
 *
 * TRUE SYNCHRONISATION. Every race uses `fireTogether`, which parks all
 * participants on one gate and releases them in a single microtask drain. No
 * `await a(); await b()` appears in any race scenario. Race-sensitive tests
 * repeat `ROUNDS` times and assert on EVERY round, so one lucky interleaving
 * cannot produce a green run.
 */
import './utils/auth-refresh-env.setup';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import {
  createE2eApp,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  API,
  createLoginableUser,
  fireTogether,
  settledValues,
  repeatRace,
  loginRequest,
  refreshRequest,
  logoutRequest,
  logoutAllRequest,
  meRequest,
  loginAndGetJar,
  snapshotTokens,
  liveTokens,
  familyOf,
  jtiOf,
  type AuthCall,
  type AuthCookies,
  type LoginableUser,
} from './utils/auth-concurrency-fixtures';

/** Rounds per race-sensitive scenario. Every round is asserted, not aggregated. */
const ROUNDS = 10;

/** Must match `test/utils/auth-refresh-env.setup.ts`. */
const RETRY_WINDOW_SECONDS = Number(
  process.env.AUTH_REFRESH_RETRY_WINDOW_SECONDS,
);
/** Production default from env.validation.ts — a retry younger than this reads as a concurrent duplicate. */
const RETRY_MIN_AGE_MS = 500;
const settleBeyondMinAge = () =>
  new Promise((resolve) => setTimeout(resolve, RETRY_MIN_AGE_MS + 150));

const OBSERVATIONS: string[] = [];
function observe(line: string): void {
  OBSERVATIONS.push(line);
}

function persistObservations(fileName: string, banner: string): void {
  const dir = join(__dirname, '..', 'docs', 'auth-audit-evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), `${OBSERVATIONS.join('\n')}\n`, 'utf8');

  console.log(`\n===== ${banner} =====\n${OBSERVATIONS.join('\n')}\n`);
}

describe('Authentication concurrency (real Postgres + Redis)', () => {
  let e2e: E2eApp;
  const createdTenants: string[] = [];

  async function newUser(label: string): Promise<LoginableUser> {
    const user = await createLoginableUser(e2e, label);
    createdTenants.push(user.tenantId);
    return user;
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
  }, 120_000);

  afterAll(async () => {
    // `cleanupTenant` deletes the tenant's users, and `refresh_tokens` is
    // ON DELETE CASCADE from `users` — so every row this suite created goes
    // with them. Nothing outside these tenants is touched.
    for (const tenantId of createdTenants) {
      await cleanupTenant(e2e, tenantId).catch(() => undefined);
    }
    await e2e.app.close();

    persistObservations(
      'auth-concurrency-observations.txt',
      'AUTH CONCURRENCY REGRESSION OBSERVATIONS',
    );
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 1 — LOGIN RACES (passed pre-fix; guarded against regression)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C1-C4 login lifecycle races', () => {
    it('C1 five truly-concurrent logins for the SAME account create five independent sessions', async () => {
      const user = await newUser('c1');

      const results = settledValues(
        await fireTogether(
          Array.from({ length: 5 }, () =>
            loginRequest(e2e, user.email, user.password),
          ),
        ),
      );

      expect(results.every((r) => r.status === 200)).toBe(true);

      const rows = await snapshotTokens(e2e, user.userId);
      const jtis = results.map((r) => jtiOf(r.cookies.refresh_token!));

      expect(rows).toHaveLength(5);
      expect(new Set(jtis).size).toBe(5);
      expect(liveTokens(rows)).toHaveLength(5);
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set(jtis));

      // Each login roots its OWN family — one login is one device chain, which
      // is precisely the scope reuse detection is allowed to revoke (AUTH-002).
      expect(new Set(rows.map((r) => r.family_id)).size).toBe(5);
      for (const row of rows) {
        expect(row.family_id).toBe(row.id);
        expect(row.parent_id).toBeNull();
      }

      observe(
        `C1 concurrent-login(x5): statuses=${results.map((r) => r.status).join(',')} rows=${rows.length} live=${liveTokens(rows).length} distinctFamilies=${new Set(rows.map((r) => r.family_id)).size}`,
      );
    }, 60_000);

    it('C1b concurrent logins race `last_login_at` but the lost update touches no session state', async () => {
      const user = await newUser('c1b');

      await fireTogether(
        Array.from({ length: 5 }, () =>
          loginRequest(e2e, user.email, user.password),
        ),
      );

      // `AuthService.login` does `user.last_login_at = new Date(); save(user)`
      // — a read-modify-write with no locking, so four of the five writes are
      // lost. Deliberately NOT fixed (AUTH-008, INFO): no authentication or
      // authorization decision anywhere reads this field. Pinned so that stays
      // true — if a future feature makes it load-bearing, this comment is the
      // warning that it is unsynchronised.
      const [row] = (await e2e.dataSource.query(
        `SELECT last_login_at FROM users WHERE id = $1`,
        [user.userId],
      )) as Array<{ last_login_at: Date | null }>;
      expect(row.last_login_at).not.toBeNull();

      // The sessions themselves are all intact — that is the part that matters.
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        5,
      );

      observe(
        'C1b last_login_at lost update confirmed benign: 5/5 sessions live',
      );
    }, 60_000);

    it('C2 concurrent logins across TWO tenants never cross-contaminate sessions', async () => {
      const a = await newUser('c2-a');
      const b = await newUser('c2-b');

      const results = settledValues(
        await fireTogether([
          loginRequest(e2e, a.email, a.password),
          loginRequest(e2e, b.email, b.password),
          loginRequest(e2e, a.email, a.password),
          loginRequest(e2e, b.email, b.password),
        ]),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);

      const rowsA = await snapshotTokens(e2e, a.userId);
      const rowsB = await snapshotTokens(e2e, b.userId);
      expect(liveTokens(rowsA)).toHaveLength(2);
      expect(liveTokens(rowsB)).toHaveLength(2);

      const tenantIds = results.map(
        (r) => (r.body.user as { tenantId: string }).tenantId,
      );
      expect(tenantIds.filter((t) => t === a.tenantId)).toHaveLength(2);
      expect(tenantIds.filter((t) => t === b.tenantId)).toHaveLength(2);

      // Families never overlap across tenants.
      const famA = new Set(rowsA.map((r) => r.family_id));
      const famB = new Set(rowsB.map((r) => r.family_id));
      expect([...famA].some((f) => famB.has(f))).toBe(false);

      observe(
        `C2 cross-tenant concurrent login: A live=${liveTokens(rowsA).length} B live=${liveTokens(rowsB).length}; family sets disjoint`,
      );
    }, 60_000);

    it('C3 login racing logout of an EXISTING session leaves both outcomes intact', async () => {
      const user = await newUser('c3');
      const first = await loginAndGetJar(e2e, user.email, user.password);
      const firstJti = jtiOf(first.refresh_token!);

      const [logoutRes, loginRes] = settledValues(
        await fireTogether<AuthCall>([
          logoutRequest(e2e, first),
          loginRequest(e2e, user.email, user.password),
        ]),
      );

      expect(logoutRes.status).toBe(204);
      expect(loginRes.status).toBe(200);

      const rows = await snapshotTokens(e2e, user.userId);
      const secondJti = jtiOf(loginRes.cookies.refresh_token!);
      expect(rows.find((r) => r.id === firstJti)!.revoked_at).not.toBeNull();
      expect(rows.find((r) => r.id === secondJti)!.revoked_at).toBeNull();

      expect((await refreshRequest(e2e, loginRes.cookies)()).status).toBe(200);

      observe('C3 login||logout: old revoked, new session live and usable');
    }, 60_000);

    it('C4 login racing refresh of an EXISTING session leaves both outcomes intact', async () => {
      const user = await newUser('c4');
      const first = await loginAndGetJar(e2e, user.email, user.password);
      const firstJti = jtiOf(first.refresh_token!);

      const [refreshRes, loginRes] = settledValues(
        await fireTogether<AuthCall>([
          refreshRequest(e2e, first),
          loginRequest(e2e, user.email, user.password),
        ]),
      );

      expect(refreshRes.status).toBe(200);
      expect(loginRes.status).toBe(200);

      const rows = await snapshotTokens(e2e, user.userId);
      expect(rows).toHaveLength(3);
      expect(rows.find((r) => r.id === firstJti)!.revoked_at).not.toBeNull();
      expect(liveTokens(rows)).toHaveLength(2);

      // The rotation child stayed in the ORIGINAL family; the new login started
      // its own. Two independent chains, exactly as intended.
      const child = rows.find((r) => r.parent_id === firstJti)!;
      expect(child.family_id).toBe(
        rows.find((r) => r.id === firstJti)!.family_id,
      );
      expect(new Set(liveTokens(rows).map((r) => r.family_id)).size).toBe(2);

      observe('C4 login||refresh: 2 live tokens in 2 distinct families');
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 2 — CONCURRENT REFRESH (AUTH-001)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C5-C6 concurrent refresh with the SAME refresh token (AUTH-001)', () => {
    /**
     * GUARDS AUTH-001 — non-atomic rotation.
     *
     * Pre-fix, `AuthService.refresh` did `findOne` -> check `revoked_at` in
     * JavaScript -> unconditional `save`. Both concurrent requests observed
     * `revoked_at IS NULL`, both passed, both minted a child: 10/10 rounds
     * returned 200/200 with two independently usable children, nullifying the
     * endpoint's documented one-time-use contract.
     *
     * The gate is now a single `UPDATE ... WHERE revoked_at IS NULL` whose
     * affected-row count IS the admission decision, so exactly one statement
     * can win.
     */
    it('C5 two concurrent refreshes on one token: exactly ONE rotates, ONE live child, family intact', async () => {
      const user = await newUser('c5');

      await repeatRace(ROUNDS, async (round) => {
        const jar = await loginAndGetJar(e2e, user.email, user.password);
        const parentJti = jtiOf(jar.refresh_token!);
        const familyId = await familyOf(e2e, parentJti);

        const outcomes = settledValues(
          await fireTogether<AuthCall>([
            refreshRequest(e2e, jar),
            refreshRequest(e2e, jar),
          ]),
        );

        const successes = outcomes.filter((o) => o.status === 200);
        const rejected = outcomes.filter((o) => o.status !== 200);

        // THE INVARIANT: one rotation, one refusal.
        expect(successes).toHaveLength(1);
        expect(rejected.map((r) => r.status)).toEqual([401]);

        const rows = await snapshotTokens(e2e, user.userId);
        const live = liveTokens(rows);

        // Exactly one usable credential exists for this family afterwards...
        expect(live).toHaveLength(1);
        expect(live[0].family_id).toBe(familyId);
        expect(live[0].id).toBe(jtiOf(successes[0].cookies.refresh_token!));
        // ...the parent is retired...
        expect(rows.find((r) => r.id === parentJti)!.revoked_at).not.toBeNull();
        // ...and the loser did NOT trip reuse detection against the winner.
        expect((await refreshRequest(e2e, successes[0].cookies)()).status).toBe(
          200,
        );

        await e2e.dataSource.query(
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [user.userId],
        );
        return round;
      });

      observe(
        `C5 concurrent-refresh(x2) over ${ROUNDS} rounds: exactly 1 success + 1x401 every round; 1 live child every round; winner's child always usable`,
      );
    }, 180_000);

    /** Same gate, wider race — the admission count must not scale with concurrency. */
    it('C6 five concurrent refreshes on one token: exactly ONE rotates', async () => {
      const user = await newUser('c6');

      await repeatRace(ROUNDS, async (round) => {
        const jar = await loginAndGetJar(e2e, user.email, user.password);

        const outcomes = settledValues(
          await fireTogether<AuthCall>(
            Array.from({ length: 5 }, () => refreshRequest(e2e, jar)),
          ),
        );

        expect(outcomes.filter((o) => o.status === 200)).toHaveLength(1);
        expect(outcomes.filter((o) => o.status === 401)).toHaveLength(4);
        expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
          1,
        );

        await e2e.dataSource.query(
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [user.userId],
        );
        return round;
      });

      observe(
        `C6 concurrent-refresh(x5) over ${ROUNDS} rounds: exactly 1 success + 4x401 every round; 1 live child every round`,
      );
    }, 180_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 3 — REUSE DETECTION, REPLAY, BLAST RADIUS (AUTH-002 / AUTH-003)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C7-C9 reuse detection is family-scoped', () => {
    /**
     * GUARDS AUTH-002 — reuse detection previously called `revokeAllForUser`,
     * so one replay killed every session the user had anywhere, including an
     * unrelated bystander on another device (measured: 0 of 2 survived).
     * It now revokes only the compromised `family_id`.
     */
    it('C7 replaying a consumed token revokes ONLY its family; unrelated sessions survive', async () => {
      const user = await newUser('c7');

      const attacked = await loginAndGetJar(e2e, user.email, user.password);
      const bystander = await loginAndGetJar(e2e, user.email, user.password);
      const attackedFamily = await familyOf(
        e2e,
        jtiOf(attacked.refresh_token!),
      );
      const bystanderJti = jtiOf(bystander.refresh_token!);

      // X -> Y, and then Y is actually USED (Y -> Z). That is what makes the
      // later replay of X unambiguous reuse rather than a lost-response retry:
      // the recorded successor is already spent.
      const y = await refreshRequest(e2e, attacked)();
      expect(y.status).toBe(200);
      const z = await refreshRequest(e2e, y.cookies)();
      expect(z.status).toBe(200);

      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        2,
      );

      // Replay the long-consumed X.
      expect((await refreshRequest(e2e, attacked)()).status).toBe(401);

      const rows = await snapshotTokens(e2e, user.userId);
      const live = liveTokens(rows);

      // The compromised family is gone in its entirety...
      expect(
        rows
          .filter((r) => r.family_id === attackedFamily)
          .every((r) => r.revoked_at !== null),
      ).toBe(true);
      expect((await refreshRequest(e2e, z.cookies)()).status).toBe(401);

      // ...and the bystander session is untouched and still usable.
      expect(live).toHaveLength(1);
      expect(live[0].id).toBe(bystanderJti);
      expect((await refreshRequest(e2e, bystander)()).status).toBe(200);

      observe(
        'C7 replay-after-rotation: 401, attacked family fully revoked, unrelated bystander session survived and refreshed successfully',
      );
    }, 90_000);

    /**
     * GUARDS AUTH-003 — `/auth/refresh` is public, so pre-fix anyone holding
     * any stale token could POST it repeatedly and terminate every session the
     * victim had, over and over (measured 3/3). The replayed token belongs to a
     * long-dead family, so it now has nothing left to revoke.
     */
    it('C9 a captured revoked token cannot force-logout sessions created after it', async () => {
      const user = await newUser('c9');

      const captured = await loginAndGetJar(e2e, user.email, user.password);
      expect((await logoutRequest(e2e, captured)()).status).toBe(204);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const victim = await loginAndGetJar(e2e, user.email, user.password);
        expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
          1,
        );

        expect((await refreshRequest(e2e, captured)()).status).toBe(401);

        // THE INVARIANT: the victim's session is untouched, every time.
        const live = liveTokens(await snapshotTokens(e2e, user.userId));
        expect(live).toHaveLength(1);
        expect(live[0].id).toBe(jtiOf(victim.refresh_token!));
        expect((await refreshRequest(e2e, victim)()).status).toBe(200);

        await logoutAllRequest(e2e, victim)();
      }

      observe(
        'C9 repeatable replay of one captured revoked token: 3/3 refused with 401, victim session survived every time (pre-fix: destroyed every time)',
      );
    }, 120_000);

    /**
     * GUARDS AUTH-003 — an EXPIRED token is the ordinary fate of every token,
     * not evidence of theft. Pre-fix it reached the whole-account revoke.
     */
    it('C8 an expired token is refused and revokes nothing at all', async () => {
      const user = await newUser('c8');

      const stale = await loginAndGetJar(e2e, user.email, user.password);
      const other = await loginAndGetJar(e2e, user.email, user.password);
      const staleJti = jtiOf(stale.refresh_token!);

      // Age the ROW only — the JWT stays signature-valid, so the request
      // reaches the row logic instead of being rejected at verification.
      await e2e.dataSource.query(
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [staleJti],
      );

      expect((await refreshRequest(e2e, stale)()).status).toBe(401);

      // Nothing revoked: not the expired token's own family, not anyone else's.
      const rows = await snapshotTokens(e2e, user.userId);
      expect(rows.find((r) => r.id === staleJti)!.revoked_at).toBeNull();
      expect(liveTokens(rows)).toHaveLength(1);
      expect((await refreshRequest(e2e, other)()).status).toBe(200);

      observe(
        'C8 expired-token replay: 401, zero revocations, unrelated session still usable',
      );
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 4 — BOUNDED RETRY WINDOW
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C15 lost-response retry is served, but strictly bounded', () => {
    /**
     * The client sent a refresh, the server rotated, and the RESPONSE was lost.
     * The client re-sends the same token. Without a retry path this is
     * indistinguishable from theft, and — with family-scoped reuse detection —
     * would sign that device out. The successor is resumed instead.
     */
    it('C15a a retry inside the window is served from the recorded successor', async () => {
      const user = await newUser('c15a');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const parentJti = jtiOf(jar.refresh_token!);
      const familyId = await familyOf(e2e, parentJti);

      // The rotation whose response the client never saw.
      const lost = await refreshRequest(e2e, jar)();
      expect(lost.status).toBe(200);

      // A real retry follows a client-side timeout. Anything faster than
      // AUTH_REFRESH_RETRY_MIN_AGE_MS is classified as a concurrent duplicate
      // and refused without revoking anything — asserted immediately below,
      // then the settle makes this a genuine retry.
      const tooSoon = await refreshRequest(e2e, jar)();
      expect(tooSoon.status).toBe(401);
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );

      await settleBeyondMinAge();

      // The client retries with the ORIGINAL token.
      const retry = await refreshRequest(e2e, jar)();
      expect(retry.status).toBe(200);

      const rows = await snapshotTokens(e2e, user.userId);
      const live = liveTokens(rows);

      // Still exactly ONE usable credential, still the same family: the retry
      // resumed the chain, it did not fork it.
      expect(live).toHaveLength(1);
      expect(live[0].family_id).toBe(familyId);
      expect(live[0].id).toBe(jtiOf(retry.cookies.refresh_token!));
      // The token the lost response carried is now retired, not left dangling.
      expect(
        rows.find((r) => r.id === jtiOf(lost.cookies.refresh_token!))!
          .revoked_at,
      ).not.toBeNull();
      // And the returned credential genuinely works.
      expect((await refreshRequest(e2e, retry.cookies)()).status).toBe(200);

      observe(
        'C15a lost-response retry inside window: 200, one live token, same family, chain resumed not forked',
      );
    }, 60_000);

    /** The window is a real bound, not a formality. */
    it('C15b the same retry AFTER the window closes is treated as reuse', async () => {
      const user = await newUser('c15b');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const familyId = await familyOf(e2e, jtiOf(jar.refresh_token!));
      const bystander = await loginAndGetJar(e2e, user.email, user.password);

      const rotated = await refreshRequest(e2e, jar)();
      expect(rotated.status).toBe(200);

      await new Promise((resolve) =>
        setTimeout(resolve, (RETRY_WINDOW_SECONDS + 1) * 1000),
      );

      expect((await refreshRequest(e2e, jar)()).status).toBe(401);

      const rows = await snapshotTokens(e2e, user.userId);
      // The expired-window replay revoked its own family...
      expect(
        rows
          .filter((r) => r.family_id === familyId)
          .every((r) => r.revoked_at !== null),
      ).toBe(true);
      expect((await refreshRequest(e2e, rotated.cookies)()).status).toBe(401);
      // ...and nothing else.
      expect(liveTokens(rows)).toHaveLength(1);
      expect((await refreshRequest(e2e, bystander)()).status).toBe(200);

      observe(
        `C15b retry ${RETRY_WINDOW_SECONDS + 1}s after a ${RETRY_WINDOW_SECONDS}s window: 401 + family revoked (reuse), unrelated session untouched`,
      );
    }, 60_000);

    /** The retry budget is a second, independent bound on the same window. */
    it('C15c retries are capped by AUTH_REFRESH_MAX_RETRIES, not just by time', async () => {
      const user = await newUser('c15c');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const maxRetries = 3; // production default, deliberately not relaxed

      await refreshRequest(e2e, jar)(); // the rotation whose response was lost

      const statuses: number[] = [];
      for (let i = 0; i < maxRetries + 1; i += 1) {
        // Each retry must clear the min-age floor to count as a retry rather
        // than a concurrent duplicate; the TIME window (2s here) is still open
        // throughout, so it is the BUDGET that stops the last one.
        await settleBeyondMinAge();
        statuses.push((await refreshRequest(e2e, jar)()).status);
      }

      // Exactly `maxRetries` served, then the budget is spent and the same
      // request becomes reuse — even though the time window is still open.
      expect(statuses.slice(0, maxRetries)).toEqual([200, 200, 200]);
      expect(statuses[maxRetries]).toBe(401);
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        0,
      );

      observe(
        `C15c retry budget: statuses=${statuses.join(',')} — capped at ${maxRetries} inside an open time window, then reuse`,
      );
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 5 — LOGOUT / ACCESS-TOKEN LIFETIME
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C10-C11 logout races and access-token lifetime', () => {
    it('C10 logout racing refresh on the SAME token: exactly one participant claims the row', async () => {
      const user = await newUser('c10');

      await repeatRace(ROUNDS, async (round) => {
        const jar = await loginAndGetJar(e2e, user.email, user.password);
        const jti = jtiOf(jar.refresh_token!);

        const [logoutRes, refreshRes] = settledValues(
          await fireTogether<AuthCall>([
            logoutRequest(e2e, jar),
            refreshRequest(e2e, jar),
          ]),
        );

        expect(logoutRes.status).toBe(204);
        expect([200, 401]).toContain(refreshRes.status);

        const rows = await snapshotTokens(e2e, user.userId);
        // The presented token is always retired, whichever side won.
        expect(rows.find((r) => r.id === jti)!.revoked_at).not.toBeNull();
        // Both operations go through a conditional UPDATE, so the outcome is
        // consistent: a live child exists iff refresh won the row.
        expect(liveTokens(rows)).toHaveLength(
          refreshRes.status === 200 ? 1 : 0,
        );

        await e2e.dataSource.query(
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [user.userId],
        );
        return round;
      });

      observe(
        `C10 logout||refresh over ${ROUNDS} rounds: presented token always revoked; live-session count always consistent with the winner`,
      );
    }, 180_000);

    /**
     * AUTH-004 — deliberately UNCHANGED, and pinned so the decision stays
     * explicit. There is no access-token denylist; `auth.controller.ts`
     * documents this and bounds it with a short `JWT_ACCESS_TTL`. Adding one
     * would mean a Redis read on every authenticated request, which the audit
     * judged not worth it at a 15-minute bound (§4, AUTH-004).
     */
    it('C11 the access token remains valid until expiry after logout (documented, bounded by JWT_ACCESS_TTL)', async () => {
      const user = await newUser('c11');

      const jar = await loginAndGetJar(e2e, user.email, user.password);
      expect((await meRequest(e2e, jar)()).status).toBe(200);

      expect((await logoutRequest(e2e, jar)()).status).toBe(204);
      expect((await meRequest(e2e, jar)()).status).toBe(200);

      // The REFRESH token, which is the thing logout actually revokes, is dead.
      expect((await refreshRequest(e2e, jar)()).status).toBe(401);

      const ttl = e2e.config.get<string>('JWT_ACCESS_TTL', '15m');
      observe(
        `C11 access token still authenticates after logout (accepted design, window = JWT_ACCESS_TTL=${ttl}); refresh token correctly refused`,
      );
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 6 — TENANT ISOLATION
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C12 multi-tenant isolation across the whole token lifecycle', () => {
    it("C12 tenant A's rotation, replay and reuse-detection cannot touch tenant B", async () => {
      const a = await newUser('c12-a');
      const b = await newUser('c12-b');

      const jarA = await loginAndGetJar(e2e, a.email, a.password);
      const jarB = await loginAndGetJar(e2e, b.email, b.password);

      // Drive A's family into reuse detection: rotate, consume the child, replay.
      const childA = await refreshRequest(e2e, jarA)();
      expect(childA.status).toBe(200);
      expect((await refreshRequest(e2e, childA.cookies)()).status).toBe(200);
      expect((await refreshRequest(e2e, jarA)()).status).toBe(401);

      expect(liveTokens(await snapshotTokens(e2e, a.userId))).toHaveLength(0);

      // B is completely untouched.
      const liveB = liveTokens(await snapshotTokens(e2e, b.userId));
      expect(liveB).toHaveLength(1);

      const refreshedB = await refreshRequest(e2e, jarB)();
      expect(refreshedB.status).toBe(200);
      expect((refreshedB.body.user as { tenantId: string }).tenantId).toBe(
        b.tenantId,
      );

      observe(
        'C12 tenant isolation: A family revoked by reuse detection, B unaffected and still rotating with the correct tenantId',
      );
    }, 90_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 7 — MULTI-INSTANCE (AUTH-001 across processes)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C13 multi-instance safety', () => {
    /**
     * GUARDS AUTH-001 across processes. Pre-fix, 5/5 rounds saw BOTH instances
     * admitted, because nothing coordinated them. The fix needs no distributed
     * lock: the serialisation point is the Postgres row, so a second instance
     * blocks on the row lock and then matches nothing.
     */
    it('C13 the same token refreshed simultaneously on TWO app instances rotates exactly once', async () => {
      const second = await createE2eApp();
      try {
        const user = await newUser('c13');

        await repeatRace(5, async (round) => {
          const jar = await loginAndGetJar(e2e, user.email, user.password);

          const outcomes = settledValues(
            await fireTogether<AuthCall>([
              refreshRequest(e2e, jar),
              refreshRequest(second, jar),
            ]),
          );

          expect(outcomes.filter((o) => o.status === 200)).toHaveLength(1);
          expect(outcomes.filter((o) => o.status === 401)).toHaveLength(1);
          expect(
            liveTokens(await snapshotTokens(e2e, user.userId)),
          ).toHaveLength(1);

          await e2e.dataSource.query(
            `DELETE FROM refresh_tokens WHERE "userId" = $1`,
            [user.userId],
          );
          return round;
        });

        observe(
          'C13 cross-instance concurrent refresh over 5 rounds: exactly 1 success + 1x401 every round (pre-fix: 5/5 both admitted)',
        );
      } finally {
        await second.app.close();
      }
    }, 300_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 8 — TOKEN VALIDATION SURFACE
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('C14 malformed, forged and misused tokens', () => {
    it('C14a a refresh token cannot be used as a bearer access token', async () => {
      const user = await newUser('c14a');
      const jar = await loginAndGetJar(e2e, user.email, user.password);

      const res = await request(e2e.app.getHttpServer())
        .get(`${API}/auth/me`)
        .set('Authorization', `Bearer ${jar.refresh_token}`);

      expect(res.status).toBe(401);
    }, 60_000);

    it('C14b refresh without the CSRF double-submit header is refused, consuming nothing', async () => {
      const user = await newUser('c14b');
      const jar = await loginAndGetJar(e2e, user.email, user.password);

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .set({
          Cookie: `refresh_token=${encodeURIComponent(jar.refresh_token!)}; csrf_token=${encodeURIComponent(jar.csrf_token!)}`,
        });

      expect(res.status).toBe(403);
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );
    }, 60_000);

    it('C14c a forged token with an unknown jti is refused and revokes nothing', async () => {
      const user = await newUser('c14c');
      const jar = await loginAndGetJar(e2e, user.email, user.password);

      const forged = await e2e.jwt.signAsync(
        {
          sub: user.userId,
          tenantId: user.tenantId,
          jti: '00000000-0000-4000-8000-000000000000',
          type: 'refresh',
        },
        {
          secret: e2e.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: '7d',
        },
      );

      const res = await refreshRequest(e2e, {
        refresh_token: forged,
        csrf_token: jar.csrf_token,
      } as AuthCookies)();
      expect(res.status).toBe(401);
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );
    }, 60_000);

    /**
     * A `jti` that is not a UUID reaches a `uuid` column comparison. Before the
     * fix added an explicit shape check this raised `invalid input syntax for
     * type uuid` — a 500 where a 401 belongs, and an error-shape oracle.
     */
    it('C14d a forged token with a MALFORMED jti is refused with 401, never a 500', async () => {
      const user = await newUser('c14d');
      const jar = await loginAndGetJar(e2e, user.email, user.password);

      for (const jti of [
        "'; DROP TABLE refresh_tokens; --",
        'not-a-uuid',
        '',
        '../../etc/passwd',
      ]) {
        const forged = await e2e.jwt.signAsync(
          { sub: user.userId, tenantId: user.tenantId, jti, type: 'refresh' },
          {
            secret: e2e.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
            expiresIn: '7d',
          },
        );
        const res = await refreshRequest(e2e, {
          refresh_token: forged,
          csrf_token: jar.csrf_token,
        } as AuthCookies)();
        expect(res.status).toBe(401);
      }

      // The table still exists and the real session is untouched.
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );
      expect((await refreshRequest(e2e, jar)()).status).toBe(200);

      observe(
        'C14d malformed/injection jti values: all 401 (never 500), session untouched',
      );
    }, 60_000);

    it('C14e a token whose stored row exists but whose VALUE was tampered with revokes nothing', async () => {
      const user = await newUser('c14e');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const jti = jtiOf(jar.refresh_token!);

      // Same jti, different signed value — the row's `token_hash` will not match.
      const impostor = await e2e.jwt.signAsync(
        { sub: user.userId, tenantId: user.tenantId, jti, type: 'refresh' },
        {
          secret: e2e.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: '8d', // different exp => different signature => different hash
        },
      );

      const res = await refreshRequest(e2e, {
        refresh_token: impostor,
        csrf_token: jar.csrf_token,
      } as AuthCookies)();
      expect(res.status).toBe(401);

      // The legitimate holder is unaffected — the bearer never held this token,
      // so it is no evidence about the real session.
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );
      expect((await refreshRequest(e2e, jar)()).status).toBe(200);

      observe(
        'C14e hash-mismatch token: 401, legitimate session untouched and still usable',
      );
    }, 60_000);
  });
});
