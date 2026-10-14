import { getRootLogger } from '../common/logging/structured-logger';
import { scrubText } from '../common/utils/log-scrubber.util';

/*
 * Minimal logger for the seed scripts.
 *
 * Standalone (`npm run seed`, or the migrate task): plain console output,
 * shape-scrubbed first (LSA-12) — this path bypasses the structured logger.
 * Inside the API/worker (the startup BootstrapSeeder): the process's
 * structured logger, so seeding lines are JSON like every other line and
 * reach the central log store parsed (LOGGING.md).
 */
type Level = 'log' | 'warn' | 'error';

function emit(
  level: Level,
  text: string,
  fallback: (scrubbed: string) => void,
): void {
  const root = getRootLogger();
  if (root) root[level](text, 'Seed');
  else fallback(scrubText(text));
}

export const logger = {
  step: (msg: string) => emit('log', msg, (t) => console.log(`\n▶ ${t}`)),
  info: (msg: string) => emit('log', msg, (t) => console.log(`  • ${t}`)),
  success: (msg: string) => emit('log', msg, (t) => console.log(`  ✓ ${t}`)),
  warn: (msg: string) => emit('warn', msg, (t) => console.warn(`  ⚠ ${t}`)),
  // The raw error object is never printed — its message only, scrubbed.
  error: (msg: string, err?: unknown) =>
    emit('error', err instanceof Error ? `${msg}: ${err.message}` : msg, (t) =>
      console.error(
        `  ✗ ${t}${err !== undefined && !(err instanceof Error) ? ` [${typeof err}]` : ''}`,
      ),
    ),
};
