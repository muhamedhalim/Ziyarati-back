/**
 * AUTHENTICATION GARBAGE-COLLECTION REGRESSION SUITE — Redis TTL, database
 * retention, cleanup safety, indexes and in-process memory. Container-backed:
 * real Postgres, real Redis, the real `AppModule`.
 *
 * POSTURE. Secure regression tests. Converted from the documenting-current-
 * behaviour audit suite once AUTH-005 (no cleanup path) and AUTH-006 (no index
 * beyond the primary key) were fixed. See docs/AUTH_CONCURRENCY_GC_AUDIT.md.
 *
 * The distinction this file exists to enforce is LOGICAL EXPIRY (a row whose
 * `expires_at` has passed) versus PHYSICAL CLEANUP (the row actually leaving
 * the table). Node's own garbage collector is responsible for neither.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';

import {
  createE2eApp,
  cleanupTenant,
  type E2eApp,
} from './utils/whatsapp-e2e-app';
import {
  API,
  createLoginableUser,
  loginAndGetJar,
  logoutRequest,
  logoutAllRequest,
  refreshRequest,
  authHeaders,
  fireTogether,
  settledValues,
  snapshotTokens,
  liveTokens,
  jtiOf,
  scanAuthKeys,
  auditRedis,
  type AuthCall,
  type AuthCookies,
  type LoginableUser,
} from './utils/auth-concurrency-fixtures';
import { BoundedLocalCounter } from '../src/queue/bounded-local-counter';
import { AuthTokenMaintenanceService } from '../src/modules/auth/auth-token-maintenance.service';
import { PasswordReset } from '../src/entities/Auth&RBAC/PasswordReset';
import { User } from '../src/entities/Auth&RBAC/User';
import { JOB } from '../src/queue/queue.constants';

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

const SRC_ROOT = join(__dirname, '..', 'src');

/** Every .ts file under src/, excluding specs. */
function sourceFiles(dir = SRC_ROOT, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Default from env.validation.ts — the sweep only touches rows older than this. */
const RETENTION_DAYS = 7;

describe('Authentication garbage collection (real Postgres + Redis)', () => {
  let e2e: E2eApp;
  let maintenance: AuthTokenMaintenanceService;
  const createdTenants: string[] = [];

  async function newUser(label: string): Promise<LoginableUser> {
    const user = await createLoginableUser(e2e, label);
    createdTenants.push(user.tenantId);
    return user;
  }

  /** Ages a row far enough past expiry to become sweep-eligible. */
  async function makeSweepEligible(ids: string[]): Promise<void> {
    await e2e.dataSource.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '${RETENTION_DAYS + 30} days' WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  beforeAll(async () => {
    e2e = await createE2eApp();
    // The sweep is a worker-side provider; instantiate it against the same
    // DataSource the API under test uses, which is exactly what the worker
    // process does at runtime.
    maintenance = new AuthTokenMaintenanceService(
      e2e.dataSource.getRepository('refresh_tokens') as never,
      e2e.dataSource.getRepository('password_resets') as never,
      e2e.config,
    );
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of createdTenants) {
      await cleanupTenant(e2e, tenantId).catch(() => undefined);
    }
    await e2e.app.close();
    persistObservations(
      'auth-token-gc-observations.txt',
      'AUTH GC REGRESSION OBSERVATIONS',
    );
  }, 120_000);

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 1 — RETENTION (AUTH-005)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G1-G2 refresh_tokens / password_resets retention', () => {
    /**
     * GUARDS AUTH-005 — before the fix, nothing anywhere deleted these rows.
     * Measured at audit time: 822 rows in a *development* database, 83%
     * expired, growing 48/day, with the only reclamation being
     * `ON DELETE CASCADE` from `users`.
     */
    it('G1 the sweep physically removes long-expired refresh tokens', async () => {
      const user = await newUser('g1');

      const jars: AuthCookies[] = [];
      for (let i = 0; i < 6; i += 1) {
        jars.push(await loginAndGetJar(e2e, user.email, user.password));
      }
      expect(await snapshotTokens(e2e, user.userId)).toHaveLength(6);

      // Retire three of them by the routes the application actually uses.
      await logoutRequest(e2e, jars[0])();
      await refreshRequest(e2e, jars[1])(); // rotation retires the parent
      await logoutAllRequest(e2e, jars[2])();

      const before = await snapshotTokens(e2e, user.userId);
      const doomed = before.slice(0, 3).map((r) => r.id);
      await makeSweepEligible(doomed);

      const result = await maintenance.purgeExpiredTokens();
      expect(result.refreshTokens).toBeGreaterThanOrEqual(3);

      const after = await snapshotTokens(e2e, user.userId);
      // THE INVARIANT: the aged rows are GONE, not merely flagged.
      for (const id of doomed) {
        expect(after.find((r) => r.id === id)).toBeUndefined();
      }
      expect(after.length).toBe(before.length - 3);

      observe(
        `G1 retention sweep: ${before.length} rows -> ${after.length}; ${result.refreshTokens} expired refresh_tokens physically deleted (pre-fix: 0, ever)`,
      );
    }, 120_000);

    it('G2 the sweep removes consumed and expired password_resets', async () => {
      const user = await newUser('g2');

      // Mint a reset token exactly as `AuthService.issuePasswordSetupToken`
      // does — same table, same hashing, same consumption endpoint — so the
      // suite can drive `POST /auth/reset-password` without the emailed value.
      const resets = e2e.dataSource.getRepository(PasswordReset);
      const rawToken = randomBytes(32).toString('hex');
      await resets.save(
        resets.create({
          user: { id: user.userId } as User,
          token_hash: createHash('sha256').update(rawToken).digest('hex'),
          expires_at: new Date(Date.now() + 30 * 60_000),
        }),
      );
      await resets.save(
        resets.create({
          user: { id: user.userId } as User,
          token_hash: createHash('sha256')
            .update(randomBytes(32).toString('hex'))
            .digest('hex'),
          expires_at: new Date(Date.now() - 60_000),
        }),
      );

      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/reset-password`)
        .send({ token: rawToken, newPassword: 'N3wAud1t!Pass' });
      expect(res.status).toBe(200);

      // Correct behaviour, unchanged by this fix: a reset revokes every session.
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        0,
      );
      expect((await refreshRequest(e2e, jar)()).status).toBe(401);

      await e2e.dataSource.query(
        `UPDATE password_resets SET expires_at = now() - interval '${RETENTION_DAYS + 30} days' WHERE "userId" = $1`,
        [user.userId],
      );
      const result = await maintenance.purgeExpiredTokens();
      expect(result.passwordResets).toBeGreaterThanOrEqual(2);

      const rows = (await e2e.dataSource.query(
        `SELECT id FROM password_resets WHERE "userId" = $1`,
        [user.userId],
      )) as Array<{ id: string }>;
      expect(rows).toHaveLength(0);

      observe(
        `G2 password_resets sweep: ${result.passwordResets} rows deleted (consumed + expired-unused); 0 remain`,
      );
    }, 120_000);

    /**
     * The single most important safety property of the sweep: it must never be
     * able to delete a row that authentication still depends on.
     */
    it('G2b the sweep never deletes live, revoked-but-unexpired, or recently-expired rows', async () => {
      const user = await newUser('g2b');

      const live = await loginAndGetJar(e2e, user.email, user.password);
      const revoked = await loginAndGetJar(e2e, user.email, user.password);
      const recentlyExpired = await loginAndGetJar(
        e2e,
        user.email,
        user.password,
      );

      await logoutRequest(e2e, revoked)(); // revoked but NOT expired
      await e2e.dataSource.query(
        // Expired, but well inside the retention margin.
        `UPDATE refresh_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`,
        [jtiOf(recentlyExpired.refresh_token!)],
      );

      const result = await maintenance.purgeExpiredTokens();
      expect(result.refreshTokens).toBe(0);

      const rows = await snapshotTokens(e2e, user.userId);
      expect(rows).toHaveLength(3);
      // The live session is untouched and still works.
      expect((await refreshRequest(e2e, live)()).status).toBe(200);

      observe(
        'G2b sweep safety: live + revoked-unexpired + recently-expired rows all retained (0 deleted); revoked-unexpired rows are kept precisely so reuse detection can still recognise a replay',
      );
    }, 120_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 2 — CLEANUP RACES (the analysis that was vacuous pre-fix)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G8 cleanup races against the live token lifecycle', () => {
    /**
     * Pre-fix these scenarios were VACUOUS — there was no cleanup job to race
     * with. Now there is, so they are real and must be proven.
     *
     * The safety argument is structural: the sweep's predicate is
     * `expires_at < now() - retention`, and `claimRefreshRow` — the single gate
     * every rotation passes through — requires `expires_at > now()`. The two
     * predicates are disjoint by a full retention window, so a row the sweep
     * can delete is one no refresh could ever have succeeded on. These tests
     * confirm that empirically under true concurrency.
     */
    it('G8a cleanup running concurrently with refresh never disturbs the rotation', async () => {
      const user = await newUser('g8a');

      for (let round = 0; round < 5; round += 1) {
        const jar = await loginAndGetJar(e2e, user.email, user.password);

        // Background noise the sweep is eligible to delete.
        const noise = await loginAndGetJar(e2e, user.email, user.password);
        await makeSweepEligible([jtiOf(noise.refresh_token!)]);

        const [sweep, refreshed] = settledValues(
          await fireTogether<AuthCall | { deleted: number }>([
            async () => ({
              deleted: (await maintenance.purgeExpiredTokens()).refreshTokens,
            }),
            refreshRequest(e2e, jar),
          ]),
        );

        expect((refreshed as AuthCall).status).toBe(200);
        expect((sweep as { deleted: number }).deleted).toBeGreaterThanOrEqual(
          1,
        );

        // The rotation child is live and usable despite the concurrent DELETE.
        const live = liveTokens(await snapshotTokens(e2e, user.userId));
        expect(live).toHaveLength(1);
        expect(
          (await refreshRequest(e2e, (refreshed as AuthCall).cookies)()).status,
        ).toBe(200);

        await e2e.dataSource.query(
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [user.userId],
        );
      }

      observe(
        'G8a cleanup||refresh x5: rotation succeeded every round, child always live and usable',
      );
    }, 180_000);

    it('G8b cleanup running concurrently with logout never disturbs the revoke', async () => {
      const user = await newUser('g8b');

      for (let round = 0; round < 5; round += 1) {
        const jar = await loginAndGetJar(e2e, user.email, user.password);
        const jti = jtiOf(jar.refresh_token!);
        const noise = await loginAndGetJar(e2e, user.email, user.password);
        await makeSweepEligible([jtiOf(noise.refresh_token!)]);

        const [, loggedOut] = settledValues(
          await fireTogether<AuthCall | { deleted: number }>([
            async () => ({
              deleted: (await maintenance.purgeExpiredTokens()).refreshTokens,
            }),
            logoutRequest(e2e, jar),
          ]),
        );

        expect((loggedOut as AuthCall).status).toBe(204);
        const rows = await snapshotTokens(e2e, user.userId);
        expect(rows.find((r) => r.id === jti)!.revoked_at).not.toBeNull();
        expect(liveTokens(rows)).toHaveLength(0);

        await e2e.dataSource.query(
          `DELETE FROM refresh_tokens WHERE "userId" = $1`,
          [user.userId],
        );
      }

      observe(
        'G8b cleanup||logout x5: revoke landed every round, 0 live sessions after',
      );
    }, 180_000);

    it('G8c cleanup racing five concurrent rotations still admits exactly one', async () => {
      const user = await newUser('g8c');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const noise = await loginAndGetJar(e2e, user.email, user.password);
      await makeSweepEligible([jtiOf(noise.refresh_token!)]);

      const outcomes = settledValues(
        await fireTogether<AuthCall | { deleted: number }>([
          async () => ({
            deleted: (await maintenance.purgeExpiredTokens()).refreshTokens,
          }),
          ...Array.from({ length: 5 }, () => refreshRequest(e2e, jar)),
        ]),
      );

      const calls = outcomes.slice(1) as AuthCall[];
      // AUTH-001's invariant is unaffected by a concurrent sweep.
      expect(calls.filter((c) => c.status === 200)).toHaveLength(1);
      expect(calls.filter((c) => c.status === 401)).toHaveLength(4);
      expect(liveTokens(await snapshotTokens(e2e, user.userId))).toHaveLength(
        1,
      );

      observe(
        'G8c cleanup||5 concurrent rotations: exactly 1 success + 4x401, 1 live child',
      );
    }, 120_000);

    it('G8d the sweep is bounded — batch size and batch count are both capped', async () => {
      const batch = e2e.config.get<number>('AUTH_TOKEN_CLEANUP_BATCH', 1000);
      const maxBatches = e2e.config.get<number>(
        'AUTH_TOKEN_CLEANUP_MAX_BATCHES',
        20,
      );

      expect(batch).toBeGreaterThan(0);
      expect(maxBatches).toBeGreaterThan(0);
      // A single pass can never be unbounded: it deletes at most batch*maxBatches
      // rows and then returns, resuming on the next tick.
      expect(batch * maxBatches).toBeLessThanOrEqual(50_000 * 1000);

      const result = await maintenance.purgeExpiredTokens();
      expect(typeof result.truncated).toBe('boolean');

      observe(
        `G8d sweep bounds: batch=${batch} maxBatches=${maxBatches} (ceiling ${batch * maxBatches} rows/pass, then resumes next tick)`,
      );
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 3 — INDEXES (AUTH-006)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G3 index coverage for every hot auth predicate', () => {
    /**
     * GUARDS AUTH-006 — both tables previously carried ONLY their primary key,
     * so `revokeAllForUser` sequentially scanned an unbounded table on every
     * logout-all, password change, password reset and (pre-fix) every
     * reuse detection, which an unauthenticated caller could trigger at will.
     */
    it('G3 refresh_tokens and password_resets carry the required indexes', async () => {
      const indexes = (await e2e.dataSource.query(
        `SELECT tablename, indexname
           FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename IN ('refresh_tokens', 'password_resets')
          ORDER BY tablename, indexname`,
      )) as Array<{ tablename: string; indexname: string }>;

      const names = indexes.map((i) => i.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'idx_refresh_tokens_user_active',
          'idx_refresh_tokens_family_active',
          'idx_refresh_tokens_expires_at',
          'idx_password_resets_expires_at',
          'idx_password_resets_token_hash',
        ]),
      );

      observe(`G3 indexes present: ${names.join(', ')}`);
    }, 60_000);

    it('G3b every hot auth predicate plans as an index scan, not a Seq Scan', async () => {
      const plans: Record<string, string> = {};

      // A pinned connection is required: `enable_seqscan` is a session setting,
      // and `dataSource.query` takes an arbitrary connection from the pool, so
      // the SET and the EXPLAIN could otherwise land on different sessions.
      // (`SET LOCAL` would need a transaction and has the same problem.)
      const runner = e2e.dataSource.createQueryRunner();
      await runner.connect();
      try {
        // On a small table the planner may legitimately prefer a Seq Scan
        // regardless of available indexes. Disabling it makes this assert INDEX
        // AVAILABILITY — the thing AUTH-006 was actually missing — rather than
        // the current row count.
        await runner.query('SET enable_seqscan = off');

        const explain = async (label: string, sql: string) => {
          const rows = (await runner.query(`EXPLAIN ${sql}`)) as Array<{
            'QUERY PLAN': string;
          }>;
          const text = rows.map((r) => r['QUERY PLAN']).join('\n');
          plans[label] = text.split('\n')[0].trim();
          return text;
        };

        const measured = {
          revokeAllForUser: await explain(
            'revokeAllForUser',
            `UPDATE refresh_tokens SET revoked_at = now() WHERE "userId" = '00000000-0000-4000-8000-000000000000' AND revoked_at IS NULL`,
          ),
          revokeFamily: await explain(
            'revokeFamily',
            `UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = '00000000-0000-4000-8000-000000000000' AND revoked_at IS NULL`,
          ),
          retentionSweep: await explain(
            'retentionSweep',
            `SELECT id FROM refresh_tokens WHERE expires_at < now() - interval '7 days' ORDER BY expires_at ASC LIMIT 1000`,
          ),
          claimRefreshRow: await explain(
            'claimRefreshRow',
            `UPDATE refresh_tokens SET revoked_at = now() WHERE id = '00000000-0000-4000-8000-000000000000' AND revoked_at IS NULL AND expires_at > now()`,
          ),
          passwordResetLookup: await explain(
            'passwordResetLookup',
            `SELECT id FROM password_resets WHERE token_hash = 'deadbeef' AND used_at IS NULL`,
          ),
        };

        for (const plan of Object.values(measured)) {
          expect(plan).not.toContain('Seq Scan');
          expect(plan).toMatch(/Index (Only )?Scan|Bitmap/);
        }
      } finally {
        await runner.release();
      }

      observe(
        `G3b query plans (Seq Scan absent in all five): ${Object.entries(plans)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' | ')}`,
      );
    }, 60_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 4 — REDIS
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G4 Redis key hygiene', () => {
    /**
     * PASSED PRE-FIX AND MUST STAY THAT WAY. Both auth limiters create their
     * counter with an atomic `INCR`-then-`EXPIRE`-only-on-create Lua script, so
     * a TTL-less auth key is structurally impossible: the EXPIRE cannot be
     * skipped by a crash between two commands, because there are not two
     * commands.
     */
    it('G4 every auth key Redis receives carries a TTL, and the lockout TTL is never extended', async () => {
      const user = await newUser('g4');
      const redis = auditRedis(e2e);

      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: user.email, password: 'wrong-password' });
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/forgot-password`)
        .send({ email: user.email });
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/reset-password`)
        .send({
          token: randomBytes(32).toString('hex'),
          newPassword: 'N3wAud1t!Pass',
        });
      await loginAndGetJar(e2e, user.email, user.password);

      const keys = await scanAuthKeys(e2e);
      const authKeys = keys.filter(
        (k) =>
          k.key.includes('auth:login:fail:') || k.key.includes('auth:abuse:'),
      );

      expect(authKeys.length).toBeGreaterThan(0);
      // -1 means "exists, no expiry" — the failure mode this asserts against.
      expect(authKeys.filter((k) => k.ttl === -1)).toHaveLength(0);
      expect(authKeys.every((k) => k.ttl > 0)).toBe(true);

      // TTL anchored at the FIRST failure, never refreshed by later ones — a
      // sliding window would let an attacker hold an account locked forever.
      const failUser = await newUser('g4-ttl');
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: failUser.email, password: 'wrong-1' });
      const failKey = (await scanAuthKeys(e2e)).find(
        (k) => k.key.includes('auth:login:fail:') && k.ttl > 0,
      );
      expect(failKey).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: failUser.email, password: 'wrong-2' });
      const ttlAfter = await redis.ttl(failKey!.key);

      expect(ttlAfter).toBeLessThan(failKey!.ttl);
      expect(ttlAfter).toBeGreaterThan(0);

      observe(
        `G4 Redis TTL: authKeys=${authKeys.length} withoutTTL=0 ttlRange=[${Math.min(...authKeys.map((k) => k.ttl))}..${Math.max(...authKeys.map((k) => k.ttl))}]s; lockout ${failKey!.ttl}s -> ${ttlAfter}s after a further failure (anchored, not sliding)`,
      );
    }, 120_000);

    /**
     * Requirement 6 of the remediation brief: no Redis session state was added.
     * The AUTH-001 fix is a Postgres conditional UPDATE precisely so that no
     * distributed lock or session cache is needed — this pins that.
     */
    it('G4b the fix introduced NO Redis session or token state', async () => {
      const user = await newUser('g4b');
      const jar = await loginAndGetJar(e2e, user.email, user.password);
      const jti = jtiOf(jar.refresh_token!);

      const rotated = await refreshRequest(e2e, jar)();
      expect(rotated.status).toBe(200);
      // Drive reuse detection too — still no Redis writes.
      await refreshRequest(e2e, rotated.cookies)();
      await refreshRequest(e2e, jar)();

      const keys = await scanAuthKeys(e2e);
      const sessionish = keys.filter(
        (k) =>
          k.key.includes(jti) ||
          k.key.includes(user.userId) ||
          /session|refresh|rotat|family|token/i.test(k.key),
      );

      expect(sessionish).toHaveLength(0);
      observe(
        'G4b no Redis key references a session, user, jti or family after rotation + reuse detection — auth state remains Postgres-only',
      );
    }, 90_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 5 — SCHEDULING (AUTH-005 wiring)
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G5 the sweep is scheduled through the EXISTING BullMQ scheduler', () => {
    /**
     * The remediation brief required reusing the existing scheduling
     * infrastructure rather than adding one. This pins both halves: the sweep
     * IS registered as a BullMQ repeatable job, and no `@Cron`/`@Interval`/
     * `@Timeout` decorator was introduced anywhere (BullMQ dedups by repeat
     * key, so registration stays single-flight across worker replicas; an
     * in-process cron would fire once per replica under API_CLUSTER_WORKERS>1).
     */
    it('G5 registered as a repeatable BullMQ job, with no scheduler decorators added', () => {
      const files = sourceFiles();
      const cronDecorators: string[] = [];

      for (const file of files) {
        const code = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        if (/@Cron\s*\(|@Interval\s*\(|@Timeout\s*\(/.test(code)) {
          cronDecorators.push(
            file.slice(SRC_ROOT.length + 1).replace(/\\/g, '/'),
          );
        }
      }
      expect(cronDecorators).toEqual([]);

      // The sweep is wired into the existing registrar and the existing queue.
      const registrar = readFileSync(
        join(SRC_ROOT, 'worker', 'schedule-registrar.service.ts'),
        'utf8',
      );
      expect(registrar).toContain('PLATFORM_AUTH_TOKEN_CLEANUP');
      expect(registrar).toMatch(
        /addRepeatable\(\s*QUEUE\.PLATFORM,\s*JOB\.PLATFORM_AUTH_TOKEN_CLEANUP/,
      );
      expect(JOB.PLATFORM_AUTH_TOKEN_CLEANUP).toBe('platform.authTokenCleanup');

      observe(
        `G5 scheduling: 0 @Cron/@Interval/@Timeout across ${files.length} source files; sweep registered as repeatable BullMQ job "${JOB.PLATFORM_AUTH_TOKEN_CLEANUP}" on the existing platform queue`,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 6 — NODE.JS MEMORY
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G6 in-process memory', () => {
    it('G6a the degraded-mode fallback is O(1) in the number of identities', () => {
      const counter = new BoundedLocalCounter({
        width: 512,
        depth: 3,
        windowMs: 60_000,
      });

      const baseline = counter.allocatedBytes;
      for (let i = 0; i < 100_000; i += 1) {
        counter.increment(`identity-${i}@example.test`);
      }

      expect(counter.allocatedBytes).toBe(baseline);
      expect(baseline).toBe(2 * 512 * 3 * 4 + 3 * 4);
      observe(
        `G6a BoundedLocalCounter after 100,000 distinct identities: allocatedBytes unchanged at ${baseline} — fixed-width table, no per-identity allocation, no timers`,
      );
    });

    it('G6b sustained login+refresh cycles retain no auth state, and rows no longer accumulate forever', async () => {
      const user = await newUser('g6b');

      for (let i = 0; i < 10; i += 1) {
        const jar = await loginAndGetJar(e2e, user.email, user.password);
        await refreshRequest(e2e, jar)();
      }

      const before = process.memoryUsage().heapUsed;
      const CYCLES = 60;
      for (let i = 0; i < CYCLES; i += 1) {
        const jar = await loginAndGetJar(e2e, user.email, user.password);
        await refreshRequest(e2e, jar)();
      }
      const after = process.memoryUsage().heapUsed;
      const perCycleBytes = (after - before) / CYCLES;

      // Reported, not tightly asserted: a jest heap reading is noisy and V8 may
      // not have collected. The load-bearing proof is G6a plus the structural
      // absence of any session-keyed Map/Set/timer/listener in the auth path.
      expect(perCycleBytes).toBeLessThan(2_000_000);

      const rows = await snapshotTokens(e2e, user.userId);
      expect(rows.length).toBeGreaterThanOrEqual(CYCLES * 2);

      // ...and unlike pre-fix, those rows are now reclaimable.
      await makeSweepEligible(rows.map((r) => r.id));
      const purged = await maintenance.purgeExpiredTokens();
      expect(purged.refreshTokens).toBeGreaterThanOrEqual(rows.length);
      expect(await snapshotTokens(e2e, user.userId)).toHaveLength(0);

      observe(
        `G6b heapUsed over ${CYCLES} login+refresh cycles: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB (${perCycleBytes.toFixed(0)} B/cycle, uncollected); ${rows.length} DB rows created and then fully reclaimed by the sweep (pre-fix: retained forever)`,
      );
    }, 300_000);
  });

  // ═══════════════════════════════════════════════════════════════════════ //
  // Section 7 — COOKIE / SERVER-STATE CONSISTENCY
  // ═══════════════════════════════════════════════════════════════════════ //

  describe('G7 cookie attributes and server-state precedence', () => {
    it('G7a auth cookie attributes are unchanged by this remediation', async () => {
      const user = await newUser('g7a');

      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/login`)
        .send({ email: user.email, password: user.password });
      expect(res.status).toBe(200);

      const raw = res.headers['set-cookie'] as unknown as string[];
      const find = (name: string) => raw.find((c) => c.startsWith(`${name}=`))!;

      expect(find('access_token')).toMatch(/HttpOnly/i);
      expect(find('access_token')).toMatch(/Path=\//i);
      expect(find('refresh_token')).toMatch(/HttpOnly/i);
      expect(find('refresh_token')).toMatch(/Path=\/api\/v1\/auth/i);
      expect(find('csrf_token')).not.toMatch(/HttpOnly/i);

      observe(
        'G7a cookies unchanged: access=[HttpOnly, Path=/], refresh=[HttpOnly, Path=/api/v1/auth], csrf=[readable]; Secure remains NODE_ENV-driven (production not observable here)',
      );
    }, 60_000);

    it('G7b the server-side row wins over the cookie in every direction', async () => {
      const user = await newUser('g7b');
      const jar = await loginAndGetJar(e2e, user.email, user.password);

      // Valid cookie, revoked row -> refused.
      await e2e.dataSource.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`,
        [jtiOf(jar.refresh_token!)],
      );
      expect((await refreshRequest(e2e, jar)()).status).toBe(401);

      // Valid cookie, row deleted entirely -> refused, no collateral revoke.
      const second = await newUser('g7b-2');
      const jar2 = await loginAndGetJar(e2e, second.email, second.password);
      await e2e.dataSource.query(`DELETE FROM refresh_tokens WHERE id = $1`, [
        jtiOf(jar2.refresh_token!),
      ]);
      expect((await refreshRequest(e2e, jar2)()).status).toBe(401);

      // Malformed and missing cookies -> refused, never a 500.
      const garbage = await request(e2e.app.getHttpServer())
        .post(`${API}/auth/refresh`)
        .set(
          authHeaders({
            refresh_token: 'not-a-jwt',
            csrf_token: jar.csrf_token,
          }),
        );
      expect(garbage.status).toBe(401);
      expect(
        (await request(e2e.app.getHttpServer()).post(`${API}/auth/refresh`))
          .status,
      ).toBe(401);

      observe(
        'G7b cookie-vs-server precedence: revoked row=401, deleted row=401, malformed cookie=401, missing cookie=401 (server-side row authoritative in all four)',
      );
    }, 90_000);
  });
});
