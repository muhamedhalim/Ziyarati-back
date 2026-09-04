import { readFileSync } from 'node:fs';
import type { TlsOptions } from 'node:tls';

/** The subset of process.env / ConfigService.get() this helper needs. */
export interface DatabaseSslEnv {
  NODE_ENV?: string;
  DB_SSL_CA?: string;
  DB_SSL_CA_CERT?: string;
}

/**
 * The three values Joi accepts for `NODE_ENV` (`env.validation.ts`). Anything
 * else reaching {@link isProductionEnv} is a typo or an unvalidated code path,
 * and is treated as production.
 */
const KNOWN_NON_PRODUCTION = new Set(['development', 'test']);

/**
 * "Is this a production environment?", answered so that an unrecognised value
 * FAILS CLOSED (P0.3 SCHEMA-007).
 *
 * This used to be `env.NODE_ENV === 'production'` — an exact, case-sensitive
 * comparison. Reached through a normal API/worker boot that is safe, because
 * Joi has already restricted `NODE_ENV` to `development|production|test` and
 * `ConfigService.get` returns the validated value. But `src/migrate.ts` —
 * the documented separate release-step migration runner for Railway / Fly /
 * ECS / Kubernetes Jobs — deliberately reads `process.env` directly and runs
 * NO Joi validation at all. Measured through the compiled factory: `PRODUCTION`,
 * `production ` (trailing space) and `prod` all took the non-production branch
 * and returned `false`, i.e. connected to the production database with
 * certificate verification entirely disabled, while succeeding silently.
 *
 * The fix is deliberately asymmetric. Values are normalised (trimmed,
 * lower-cased) so obvious variants resolve correctly, and anything still
 * unrecognised is treated as PRODUCTION — which forces the caller to supply a
 * CA and therefore fails loudly, instead of quietly downgrading TLS. Getting
 * this wrong in the safe direction costs a clear boot error in a dev
 * environment with a mistyped variable; getting it wrong in the other
 * direction costs an unauthenticated production database connection.
 */
export function isProductionEnv(nodeEnv: string | undefined): boolean {
  const normalised = String(nodeEnv ?? '')
    .trim()
    .toLowerCase();
  if (normalised === '') return false; // genuinely unset — local development
  return !KNOWN_NON_PRODUCTION.has(normalised);
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
  const isProduction = isProductionEnv(env.NODE_ENV);
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
