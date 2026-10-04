/**
 * Standalone Tap go-live preflight — `node dist/src/tap-preflight.js [flags]`.
 *
 * Run it as a ONE-OFF task with the API task definition (so it sees exactly the
 * env and secrets the service boots with), before and after each rollout step.
 * It is read-only (see `modules/payments/preflight/tap-preflight.ts`) and never
 * prints a key, a signature or an env value.
 *
 * Flags:
 *   --expect-active       FAIL unless PAYMENT_PROVIDER=tap (use after the flip)
 *   --expect-env=live|sandbox
 *   --expect-flags-off    FAIL if TAP_RECURRING_ENABLED / TAP_BOOKING_PAYMENTS_ENABLED is on
 *   --probe-webhook       POST a signed and a wrongly-signed synthetic webhook to TAP_WEBHOOK_URL
 *   --no-frontend         skip the GET of ${APP_URL}/pay/return
 *   --timeout-ms=N        per-request timeout (default 15000)
 *
 * Exit code 0 = no check FAILed (WARN and SKIP do not fail), 1 = at least one did.
 */
import { validate } from './config/env.validation';
import {
  formatPreflight,
  runTapPreflight,
  type PreflightOptions,
} from './modules/payments/preflight/tap-preflight';

function parseArgs(argv: string[]): Partial<PreflightOptions> {
  const opts: Partial<PreflightOptions> = {};
  for (const arg of argv) {
    if (arg === '--probe-webhook') opts.probeWebhook = true;
    else if (arg === '--no-frontend') opts.checkFrontend = false;
    else if (arg === '--expect-active') opts.expectActive = true;
    else if (arg === '--expect-flags-off') opts.expectFlagsOff = true;
    else if (arg.startsWith('--expect-env=')) {
      const v = arg.slice('--expect-env='.length);
      if (v !== 'live' && v !== 'sandbox') {
        throw new Error(`--expect-env must be "live" or "sandbox", got "${v}"`);
      }
      opts.expectEnv = v;
    } else if (arg.startsWith('--timeout-ms=')) {
      const n = Number(arg.slice('--timeout-ms='.length));
      if (!Number.isInteger(n) || n < 1000 || n > 120000) {
        throw new Error(
          '--timeout-ms must be an integer between 1000 and 120000',
        );
      }
      opts.timeoutMs = n;
    } else {
      throw new Error(`Unknown flag "${arg}"`);
    }
  }
  return opts;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runTapPreflight(
    { env: process.env, fetch, validate },
    opts,
  );
  console.log(formatPreflight(report));
  return report.ok ? 0 : 1;
}

main()
  .then((code) => setTimeout(() => process.exit(code), 200))
  .catch((err) => {
    // Argument errors only — every check handles its own failures.
    console.error(`TAP_PREFLIGHT_FAIL\n${(err as Error)?.message ?? err}`);
    setTimeout(() => process.exit(1), 200);
  });
