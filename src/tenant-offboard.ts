/**
 * Standalone tenant offboarding — `node dist/src/tenant-offboard.js --tenant <id> --confirm <id> [--apply]`.
 *
 * IRREVERSIBLE with `--apply`. Run it as a ONE-OFF task with the API task
 * definition (same env, same database, same storage), after the clinic has been
 * SUSPENDED — an active clinic is refused.
 *
 * DRY RUN BY DEFAULT: without `--apply` every delete runs and is rolled back, so
 * the printed counts are exact and nothing changes. It prints table names and
 * counts only, never a row value. See `modules/data-governance/tenant-offboarding.service.ts`
 * for what it cannot reach (backups, Redis, logs, processors).
 *
 * A clinic with rows in the immutable payment ledger is REFUSED unless `--purge-ledger` is also
 * given: whether an accounting record may be erased is a legal decision, never a default.
 *
 * Exit code 0 = COMPLETED (or a dry run), 1 = failed or PARTIAL.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';

import dataSource from './config/data-source';
import { validate } from './config/env.validation';
import { StorageService } from './modules/storage/storage.service';
import { TenantOffboardingService } from './modules/data-governance/tenant-offboarding.service';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const i = process.argv.findIndex(
    (a) => a === `--${name}` || a.startsWith(prefix),
  );
  if (i === -1) return undefined;
  const a = process.argv[i];
  return a.startsWith(prefix) ? a.slice(prefix.length) : process.argv[i + 1];
}

async function main(): Promise<number> {
  const tenant = arg('tenant');
  const confirm = arg('confirm');
  const apply = process.argv.includes('--apply');
  if (!tenant || !confirm) {
    process.stderr.write(
      'usage: tenant-offboard --tenant <id> --confirm <id> [--apply] [--purge-ledger]\n',
    );
    return 1;
  }
  const config = new ConfigService(
    validate(process.env as Record<string, unknown>),
  );
  await dataSource.initialize();
  try {
    const service = new TenantOffboardingService(
      dataSource,
      new StorageService(config),
    );
    const result = await service.offboard(tenant, {
      confirm,
      dryRun: !apply,
      purgeLedger: process.argv.includes('--purge-ledger'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!apply)
      process.stdout.write(
        'Dry run — nothing was changed. Re-run with --apply to delete this clinic.\n',
      );
    return result.status === 'COMPLETED' ? 0 : 1;
  } finally {
    await dataSource.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `tenant offboarding failed: ${(err as Error)?.message ?? String(err)}\n`,
    );
    process.exit(1);
  },
);
