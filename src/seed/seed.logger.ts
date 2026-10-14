import { getRootLogger } from '../common/logging/structured-logger';

/*
 * Minimal logger for the seed scripts.
 *
 * Standalone (`npm run seed`): plain console output, as before.
 * Inside the API/worker (the startup BootstrapSeeder): the process's
 * structured logger, so seeding lines are JSON like every other line and
 * reach the central log store parsed (LOGGING.md).
 */
type Level = 'log' | 'warn' | 'error';

function emit(level: Level, text: string, fallback: () => void): void {
  const root = getRootLogger();
  if (root) root[level](text, 'Seed');
  else fallback();
}

export const logger = {
  step: (msg: string) => emit('log', msg, () => console.log(`\n▶ ${msg}`)),
  info: (msg: string) => emit('log', msg, () => console.log(`  • ${msg}`)),
  success: (msg: string) => emit('log', msg, () => console.log(`  ✓ ${msg}`)),
  warn: (msg: string) => emit('warn', msg, () => console.warn(`  ⚠ ${msg}`)),
  error: (msg: string, err?: unknown) =>
    emit('error', err instanceof Error ? `${msg}: ${err.message}` : msg, () =>
      console.error(`  ✗ ${msg}`, err ?? ''),
    ),
};
