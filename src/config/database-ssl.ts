import { readFileSync } from 'node:fs';
import type { TlsOptions } from 'node:tls';

/** The subset of process.env / ConfigService.get() this helper needs. */
export interface DatabaseSslEnv {
  NODE_ENV?: string;
  DB_SSL_CA?: string;
  DB_SSL_CA_CERT?: string;
}

/**
 * Single shared PostgreSQL TLS policy (ZT-012), sourced from ONE place and
 * called from all three production connection sites — the migration
 * `DataSource` (`run-migrations-with-lock.ts`, opens the FIRST connection of
 * any boot), the runtime `DataSource` (`typeorm.config.ts`, serves both the
 * API and worker process roots) and the CLI `DataSource`
 * (`data-source.ts`, `migration:generate`). Three divergent inline copies of
 * `{ rejectUnauthorized: false }` is exactly the drift that produced this
 * finding — this file exists so certificate policy cannot diverge again.
 *
 * Non-production: `false`, byte-identical to every site's previous
 * behaviour — local development and the existing test suites are
 * unaffected.
 *
 * Production: verifies the server certificate against a trust anchor
 * sourced from configuration — `DB_SSL_CA` (a filesystem path) or
 * `DB_SSL_CA_CERT` (an inline PEM), exactly one of which is required by the
 * Joi schema. NEVER falls back to `rejectUnauthorized: false`, and NEVER
 * inspects, logs or echoes certificate content — only reads it to hand to
 * Node's TLS layer.
 *
 * The Joi schema already enforces "exactly one of the two is present" in
 * production (env.validation.ts), so the throw below is a defensive
 * second layer for any call site NOT reached through that validation — the
 * standalone CLI DataSource (`data-source.ts`) reads `process.env` directly
 * and is outside the Nest/ConfigModule graph entirely, so it is the one
 * site that genuinely depends on this check rather than merely duplicating
 * it.
 */
export function databaseSslOptions(env: DatabaseSslEnv): boolean | TlsOptions {
  const isProduction = env.NODE_ENV === 'production';
  if (!isProduction) return false;

  const inlineCert = String(env.DB_SSL_CA_CERT ?? '').trim();
  const caPath = String(env.DB_SSL_CA ?? '').trim();

  let ca: string | undefined;
  if (inlineCert) {
    ca = inlineCert;
  } else if (caPath) {
    try {
      ca = readFileSync(caPath, 'utf8');
    } catch (err) {
      throw new Error(
        `❌ Database SSL error: DB_SSL_CA is set but could not be read (${(err as Error).message}). ` +
          `The path must resolve to a readable PEM trust anchor.`,
      );
    }
  }

  if (!ca) {
    throw new Error(
      `❌ Database SSL error: production requires exactly one of DB_SSL_CA (a file path) or ` +
        `DB_SSL_CA_CERT (an inline PEM) to be set. Refusing to connect without validating the ` +
        `server certificate — see specs/008-security-hardening-p1 ZT-012.`,
    );
  }

  return { rejectUnauthorized: true, ca };
}
