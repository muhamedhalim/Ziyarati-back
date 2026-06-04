/* Minimal, dependency-free logger for the standalone seed scripts. */
export const logger = {
  step: (msg: string) => console.log(`\n▶ ${msg}`),
  info: (msg: string) => console.log(`  • ${msg}`),
  success: (msg: string) => console.log(`  ✓ ${msg}`),
  warn: (msg: string) => console.warn(`  ⚠ ${msg}`),
  error: (msg: string, err?: unknown) =>
    console.error(`  ✗ ${msg}`, err ?? ''),
};
