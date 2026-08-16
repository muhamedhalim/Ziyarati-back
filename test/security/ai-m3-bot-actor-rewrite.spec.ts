/**
 * T024 — migration M3 (`BotActorTenantQualifiedEmail1730041200000`,
 * `AI-001`, R10): a pre-existing legacy-addressed bot row (from before this
 * feature's code fix shipped) is rewritten to the tenant-qualified address
 * in place, preserving the row identifier, with the row's own tenant
 * relation as the only source of the derived address — never a parameter.
 *
 * Invokes the migration class directly against a `QueryRunner` from the real
 * harness `DataSource`, rather than relying on the `migrations` tracking
 * table's applied/unapplied state — this test seeds a legacy row that never
 * existed when the migration first (if ever) ran against this database, so
 * it must be able to exercise `up()`/`down()` on demand regardless of what
 * TypeORM's own bookkeeping currently believes.
 */
import {
  buildAiAuditHarness,
  type AiAuditHarness,
} from './fixtures/ai-audit-harness';
import {
  seedAiAudit,
  teardownAiAuditSeed,
  type AiAuditSeed,
} from './fixtures/ai-audit-seed';
import { BotActorTenantQualifiedEmail1730041200000 } from '../../src/migrations/1730041200000-BotActorTenantQualifiedEmail';

const LEGACY_EMAIL = 'ai-bot@bot.internal';
const qualifiedEmail = (tenantId: string) => `ai-bot+${tenantId}@bot.internal`;

describe('M3 — bot-actor tenant-qualified email migration (T024, AI-001)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  const migration = new BotActorTenantQualifiedEmail1730041200000();

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  afterEach(async () => {
    // Belt-and-braces cleanup in case an assertion fails mid-test and leaves
    // a synthetic bot row behind — every test seeds its own and cleans it up
    // on the happy path, but this guards the negative/error-path tests too.
    await harness.dataSource
      .query(`DELETE FROM users WHERE email IN ($1, $2, $3)`, [
        LEGACY_EMAIL,
        qualifiedEmail(seed.tenantA.id),
        qualifiedEmail(seed.tenantB.id),
      ])
      .catch(() => undefined);
  });

  it('rewrites a pre-existing legacy-addressed row to the tenant-qualified address, preserving the row id', async () => {
    const [legacyRow] = await harness.dataSource.query(
      `INSERT INTO users (email, "tenantId", full_name, is_active) VALUES ($1, $2, 'AI Assistant', true) RETURNING id`,
      [LEGACY_EMAIL, seed.tenantA.id],
    );
    const originalId = legacyRow.id as string;

    const qr = harness.dataSource.createQueryRunner();
    try {
      await migration.up(qr);

      const rows = await harness.dataSource.query(
        `SELECT id, email FROM users WHERE email = $1`,
        [qualifiedEmail(seed.tenantA.id)],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(originalId); // identifier unchanged

      const legacyLeft = await harness.dataSource.query(
        `SELECT id FROM users WHERE email = $1`,
        [LEGACY_EMAIL],
      );
      expect(legacyLeft).toHaveLength(0); // exactly one bot row for that tenant — none at the old address

      // Second run is a harmless no-op: no legacy-addressed row remains, so
      // the SELECT that drives up() returns nothing to rewrite.
      await migration.up(qr);
      const afterSecondUp = await harness.dataSource.query(
        `SELECT id, email FROM users WHERE id = $1`,
        [originalId],
      );
      expect(afterSecondUp).toHaveLength(1);
      expect(afterSecondUp[0].email).toBe(qualifiedEmail(seed.tenantA.id)); // unchanged

      // down() restores the legacy address for the row it (would have) rewritten.
      await migration.down(qr);
      const afterDown = await harness.dataSource.query(
        `SELECT id, email FROM users WHERE id = $1`,
        [originalId],
      );
      expect(afterDown).toHaveLength(1);
      expect(afterDown[0].email).toBe(LEGACY_EMAIL);

      // up→down→up round trip: re-applying restores the qualified form.
      await migration.up(qr);
      const afterSecondCycle = await harness.dataSource.query(
        `SELECT id, email FROM users WHERE id = $1`,
        [originalId],
      );
      expect(afterSecondCycle).toHaveLength(1);
      expect(afterSecondCycle[0].email).toBe(qualifiedEmail(seed.tenantA.id));
    } finally {
      await qr.release();
    }
  }, 30_000);

  it('running with no legacy row present is a harmless no-op', async () => {
    const qr = harness.dataSource.createQueryRunner();
    try {
      const before = await harness.dataSource.query(
        `SELECT count(*)::int AS n FROM users WHERE email = $1`,
        [LEGACY_EMAIL],
      );
      expect(before[0].n).toBe(0);

      await expect(migration.up(qr)).resolves.not.toThrow();
      await expect(migration.down(qr)).resolves.not.toThrow();

      const after = await harness.dataSource.query(
        `SELECT count(*)::int AS n FROM users WHERE email = $1`,
        [LEGACY_EMAIL],
      );
      expect(after[0].n).toBe(0);
    } finally {
      await qr.release();
    }
  }, 30_000);

  it('refuses loudly rather than guessing when a tenant holds both a legacy row and a qualified row (FR-002a)', async () => {
    const [legacyRow] = await harness.dataSource.query(
      `INSERT INTO users (email, "tenantId", full_name, is_active) VALUES ($1, $2, 'AI Assistant', true) RETURNING id`,
      [LEGACY_EMAIL, seed.tenantB.id],
    );
    await harness.dataSource.query(
      `INSERT INTO users (email, "tenantId", full_name, is_active) VALUES ($1, $2, 'AI Assistant (already qualified)', true)`,
      [qualifiedEmail(seed.tenantB.id), seed.tenantB.id],
    );

    const qr = harness.dataSource.createQueryRunner();
    try {
      await expect(migration.up(qr)).rejects.toThrow(
        /already holds a qualified-address bot row/i,
      );

      // Neither row was mutated by the refused attempt.
      const legacyStill = await harness.dataSource.query(
        `SELECT id FROM users WHERE id = $1 AND email = $2`,
        [legacyRow.id, LEGACY_EMAIL],
      );
      expect(legacyStill).toHaveLength(1);
    } finally {
      await qr.release();
      await harness.dataSource
        .query(
          `DELETE FROM users WHERE "tenantId" = $1 AND (email = $2 OR email = $3)`,
          [seed.tenantB.id, LEGACY_EMAIL, qualifiedEmail(seed.tenantB.id)],
        )
        .catch(() => undefined);
    }
  }, 30_000);
});
