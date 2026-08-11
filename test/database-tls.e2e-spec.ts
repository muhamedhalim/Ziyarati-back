/**
 * ZT-012 — production database TLS must AUTHENTICATE the server, not merely
 * encrypt the transport. Before this fix: `ssl: { rejectUnauthorized: false }`
 * at all three production connection sites meant a production-mode boot
 * against a database presenting ANY certificate — including one whose CN
 * matches nothing this deployment owns — connected successfully. This is
 * the audit's own reproduction: a disposable Postgres presenting a
 * self-signed certificate `CN=totally-not-the-real-db`
 * (test/fixtures/zt012-tls/untrusted.crt) that the app must now refuse.
 *
 * Requires two disposable, SSL-enabled Postgres containers (never the
 * shared dev database, never production) — see
 * test/fixtures/zt012-tls/README.md for how their certificates were
 * generated and quickstart.md §7d for the container setup:
 *   - "trusted": presents server.crt, signed by ca.crt.
 *   - "untrusted": presents untrusted.crt, a self-signed cert unrelated to
 *     ca.crt (CN=totally-not-the-real-db).
 *
 * Both default to the ports these fixtures were provisioned on
 * (55433/55434); override via ZT012_TRUSTED_PG_PORT/ZT012_UNTRUSTED_PG_PORT
 * if provisioned elsewhere.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { runMigrationsWithAdvisoryLock } from '../src/config/run-migrations-with-lock';
import { databaseSslOptions } from '../src/config/database-ssl';

const FIXTURES_DIR = join(__dirname, 'fixtures', 'zt012-tls');
const CA = readFileSync(join(FIXTURES_DIR, 'ca.crt'), 'utf8');

const TRUSTED_PORT = Number(process.env.ZT012_TRUSTED_PG_PORT ?? 55433);
const UNTRUSTED_PORT = Number(process.env.ZT012_UNTRUSTED_PG_PORT ?? 55434);

const urlFor = (port: number) =>
  `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

/** The exact production ssl-options shape all three sites now share. */
const correctSsl = databaseSslOptions({
  NODE_ENV: 'production',
  DB_SSL_CA_CERT: CA,
});

describe('ZT-012 — database TLS certificate validation (isolated, own PR)', () => {
  // ── Schema-level guarantees already proven in env.validation.spec.ts:
  // production refuses to boot with neither/both of DB_SSL_CA/DB_SSL_CA_CERT
  // set, and databaseSslOptions() never returns `false`/no-validation in
  // production for any input (database-ssl.spec.ts). This file covers the
  // one thing those unit suites cannot: a REAL TLS handshake against a REAL
  // (disposable) Postgres server.

  describe('the inverted proof — untrusted certificate', () => {
    it('the migration DataSource refuses to connect (this is the FIRST connection any boot opens)', async () => {
      await expect(
        runMigrationsWithAdvisoryLock(urlFor(UNTRUSTED_PORT), correctSsl),
      ).rejects.toThrow();
    }, 30_000);

    it('the runtime DataSource shape also refuses (same ssl policy, both process roots)', async () => {
      const ds = new DataSource({
        type: 'postgres',
        url: urlFor(UNTRUSTED_PORT),
        ssl: correctSsl,
      });
      await expect(ds.initialize()).rejects.toThrow();
      // initialize() failed, so there is nothing live to destroy — but guard
      // against a partial connection leaking a handle if the assertion above
      // ever starts failing.
      if (ds.isInitialized) await ds.destroy();
    }, 30_000);
  });

  describe('the positive path — matching CA', () => {
    it('the migration DataSource connects and runs migrations normally against the trusted fixture', async () => {
      await expect(
        runMigrationsWithAdvisoryLock(urlFor(TRUSTED_PORT), correctSsl),
      ).resolves.not.toThrow();
    }, 60_000);

    it('the runtime DataSource shape connects normally against the trusted fixture', async () => {
      const ds = new DataSource({
        type: 'postgres',
        url: urlFor(TRUSTED_PORT),
        ssl: correctSsl,
      });
      await ds.initialize();
      expect(ds.isInitialized).toBe(true);
      await ds.destroy();
    }, 30_000);
  });

  describe('non-production connectivity is unchanged (ZT-012 FR-029)', () => {
    it('ssl:false still connects to a plain (non-SSL) Postgres, exactly as before this feature', async () => {
      // The disposable Postgres every OTHER 008 e2e suite already uses
      // throughout this feature (never SSL-enabled) — hundreds of
      // successful non-production connections across Phases 3-10 are
      // already the extended proof of this; this is the direct, minimal one.
      const nonProdSsl = databaseSslOptions({ NODE_ENV: 'test' });
      expect(nonProdSsl).toBe(false);

      const ds = new DataSource({
        type: 'postgres',
        host: '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 55432),
        username: 'postgres',
        password: 'postgres',
        database: 'postgres',
        ssl: nonProdSsl,
      });
      await ds.initialize();
      expect(ds.isInitialized).toBe(true);
      await ds.destroy();
    }, 30_000);
  });
});
