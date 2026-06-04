import { SeedDataSource } from './data-source';
import { runSeeders } from './index.seed';
import { logger } from './seed.logger';

/**
 * Entry point for the standalone seeder.
 *   npm run seed
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  logger.step('Connecting to database');
  await SeedDataSource.initialize();
  logger.success(`connected to "${SeedDataSource.options.database}"`);

  try {
    await runSeeders(SeedDataSource);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(2);
    logger.step(`Seeding completed successfully in ${seconds}s ✅`);
  } finally {
    await SeedDataSource.destroy();
  }
}

main().catch((err) => {
  logger.error('Seeding failed — database left unchanged', err);
  // Ensure the connection is torn down even on failure.
  if (SeedDataSource.isInitialized) {
    void SeedDataSource.destroy();
  }
  process.exit(1);
});
