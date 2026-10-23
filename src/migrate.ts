/**
 * Standalone migration entrypoint — `node dist/src/migrate.js`.
 *
 * WHY THIS EXISTS, given `typeOrmFactory` already runs migrations on boot:
 * the boot-time run (behind `run-migrations-with-lock.ts`'s Postgres advisory
 * lock) is the safety net that guarantees no process ever serves traffic
 * against an unmigrated schema. It is NOT a deployment step you can observe,
 * gate on, or roll back — it is entangled with application startup. Platforms
 * that offer a release/pre-deploy phase (ECS one-off tasks, Fly, Kubernetes Jobs)
 * want migrations as their OWN unit of work that either succeeds or fails the
 * deploy before a single container starts serving. This file is that unit.
 *
 * Running both is safe and expected: whichever runs first applies the pending
 * migrations, the other finds none pending. `run` and `revert` take the same
 * Postgres advisory lock the boot-time runner holds, so they can never interleave
 * with it (or with each other) - CR-11.
 * Both go through the SAME
 * `data-source.ts` — identical entities glob, identical migrations glob,
 * identical `migrationsTransactionMode: 'each'`, identical TLS policy — so
 * this can never apply a different set than the app would.
 *
 * Commands (argv[2], default `run`):
 *   run     — apply every pending migration, then exit 0. Exit 1 on failure.
 *   show    — print applied/pending status, exit 0. Read-only.
 *   revert  — roll back the single most recently applied migration.
 *
 * Reads configuration from the process environment ONLY (no dotenv, no .env
 * file inside the image). Never prints a connection string, credential or
 * certificate. It runs NO Joi validation by design, so it validates the one
 * variable whose misreading is silently dangerous — NODE_ENV — itself; see
 * `assertKnownNodeEnv` (P0.3 SCHEMA-007).
 */
import 'reflect-metadata';

import AppDataSource from './config/data-source';
import { withMigrationAdvisoryLock } from './config/run-migrations-with-lock';
import {
  scrubFailureReason,
  scrubText,
} from './common/utils/log-scrubber.util';

type Command = 'run' | 'show' | 'revert';

const COMMANDS: readonly Command[] = ['run', 'show', 'revert'];

function parseCommand(argv: string[]): Command {
  const raw = (argv[2] ?? 'run').trim();
  if ((COMMANDS as readonly string[]).includes(raw)) return raw as Command;
  throw new Error(
    `Unknown migration command "${raw}". Expected one of: ${COMMANDS.join(', ')}.`,
  );
}

/** Redacts everything but the database name — never echo credentials or host. */
function safeTarget(): string {
  try {
    const parsed = new URL(process.env.DATABASE_URL ?? '');
    return parsed.pathname.replace(/^\//, '') || '(unnamed database)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * P0.3 SCHEMA-007. This entrypoint deliberately sits outside the Nest /
 * ConfigModule graph and therefore runs no Joi validation, so `NODE_ENV`
 * arrives here exactly as the platform set it — including typos. Certificate
 * policy (`config/database-ssl.ts`) now fails closed on an unrecognised value,
 * but silently treating `PRODUCTION` as production while the rest of the
 * deployment treats it as something else is still a configuration bug worth
 * refusing outright. Joi accepts exactly three values; so does this.
 */
function assertKnownNodeEnv(): void {
  const raw = process.env.NODE_ENV;
  if (raw === undefined || raw === '') return; // unset — same as Joi's default
  const allowed = ['development', 'production', 'test'];
  if (!allowed.includes(raw)) {
    throw new Error(
      `NODE_ENV is "${raw}", which is not one of ${allowed.join(', ')}. ` +
        `Refusing to run migrations: a value this entrypoint does not recognise ` +
        `(a case difference or stray whitespace included) means the migration job ` +
        `and the application may not agree on TLS or environment policy. ` +
        `Set NODE_ENV to the exact intended value.`,
    );
  }
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv);
  assertKnownNodeEnv();

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — cannot run migrations.');
  }

  console.log(
    `[migrate] command=${command} database=${safeTarget()} nodeEnv=${process.env.NODE_ENV ?? 'undefined'}`,
  );

  await AppDataSource.initialize();
  try {
    if (command === 'show') {
      // `showMigrations()` prints the applied/pending table itself and returns
      // true when at least one migration is still pending.
      const pending = await AppDataSource.showMigrations();
      console.log(
        pending
          ? '[migrate] result: PENDING migrations exist.'
          : '[migrate] result: schema is up to date, nothing pending.',
      );
      return;
    }

    if (command === 'revert') {
      await withMigrationAdvisoryLock(AppDataSource, () =>
        AppDataSource.undoLastMigration(),
      );
      console.log('[migrate] reverted the most recently applied migration.');
      return;
    }

    const applied = await withMigrationAdvisoryLock(AppDataSource, () =>
      AppDataSource.runMigrations(),
    );
    if (applied.length === 0) {
      console.log('[migrate] no pending migrations — schema already current.');
    } else {
      for (const migration of applied) {
        console.log(`[migrate]   applied ${migration.name}`);
      }
      console.log(`[migrate] applied ${applied.length} migration(s).`);
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main()
  .then(() => {
    console.log('[migrate] done.');
    process.exit(0);
  })
  .catch((err: unknown) => {
    // LSA-01/LSA-12: a driver message can quote a row value
    // (`invalid input syntax …: "<value>"`) — scrub by shape before printing.
    console.error(`[migrate] FAILED: ${scrubFailureReason(err, 2_000)}`);
    if (err instanceof Error && err.stack) console.error(scrubText(err.stack));
    process.exit(1);
  });
