/**
 * Standalone retention sweep — `node dist/src/retention-run.js [--apply]`.
 *
 * Run as a ONE-OFF task with the API task definition (so it sees the same env
 * and the same database). DRY RUN BY DEFAULT: without `--apply` it only counts
 * what it would remove. It prints counts and table names, never a row value.
 *
 * Nothing is selected unless the matching `RETENTION_*_DAYS` setting is given
 * (see `modules/data-governance/retention-policy.ts`); with none set it reports
 * every target as `no_setting` and exits 0. There are deliberately no defaults:
 * how long a record may be kept is a legal input (plan L12).
 *
 * Exit code 0 = ran, 1 = failed.
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';

import dataSource from './config/data-source';
import { validate } from './config/env.validation';
import { RetentionService } from './modules/data-governance/retention.service';

async function main(): Promise<number> {
  const apply = process.argv.includes('--apply');
  const config = new ConfigService(
    validate(process.env as Record<string, unknown>),
  );
  await dataSource.initialize();
  try {
    const service = new RetentionService(dataSource, config);
    const result = await service.run({ dryRun: !apply });
    // Counts and table names only.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!apply)
      process.stdout.write(
        'Dry run — nothing was changed. Re-run with --apply to remove these rows.\n',
      );
    return 0;
  } finally {
    await dataSource.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `retention run failed: ${(err as Error)?.message ?? String(err)}\n`,
    );
    process.exit(1);
  },
);
