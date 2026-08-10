'use strict';

/**
 * PERF-CACHE-001 multi-instance validation. `FailsafeThrottlerStorage`'s
 * degraded-mode fallback (`ThrottlerStorageService`, NestJS's own built-in
 * default) is IN-MEMORY, i.e. per-process. Under normal operation (Redis
 * up) every instance shares one counter via Redis, so the configured limit
 * (300 req/60s) is a true platform-wide ceiling regardless of instance
 * count. This probe measures what happens to that guarantee during a Redis
 * outage with >1 API instance: does each instance enforce its own
 * independent 300, making the EFFECTIVE aggregate limit (instances x 300)?
 *
 * Fires `--n` rapid sequential requests at ONE instance (expected to exceed
 * 300 and start seeing 429s), then fires a smaller batch at the OTHER
 * instance and reports whether it is unaffected (still all 200) — the
 * signature of two independent, non-communicating counters.
 *
 * Usage:
 *   node scripts/perf/cache001-multiinstance-probe.js --portA=3001 --portB=3002 --n=320
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PORT_A = Number(args.portA || 3001);
const PORT_B = Number(args.portB || 3002);
const N = Number(args.n || 320);
const ENDPOINT = '/api/v1/system/health/readiness';

async function fireSequential(port, n) {
  let ok = 0;
  let throttled = 0;
  let other = 0;
  let firstThrottledAt = null;
  for (let i = 1; i <= n; i++) {
    const res = await fetch(`http://127.0.0.1:${port}${ENDPOINT}`);
    if (res.status === 200) ok++;
    else if (res.status === 429) {
      throttled++;
      if (firstThrottledAt === null) firstThrottledAt = i;
    } else other++;
    await res.text().catch(() => {});
  }
  return { port, n, ok, throttled, other, firstThrottledAt };
}

async function main() {
  console.log(`[cache001-multiinstance] firing ${N} sequential requests at instance A (port ${PORT_A})...`);
  const a = await fireSequential(PORT_A, N);
  console.log('[cache001-multiinstance] instance A result:', JSON.stringify(a));

  const nB = Math.min(50, N);
  console.log(`[cache001-multiinstance] firing ${nB} sequential requests at instance B (port ${PORT_B}, independent process)...`);
  const b = await fireSequential(PORT_B, nB);
  console.log('[cache001-multiinstance] instance B result:', JSON.stringify(b));

  const verdict = a.throttled > 0 && b.throttled === 0 && b.ok === nB
    ? 'CONFIRMED: instance B unaffected by instance A hitting its own throttle limit — independent, per-process counters during this degraded mode.'
    : 'INCONCLUSIVE — see raw counts above.';
  console.log(`[cache001-multiinstance] VERDICT: ${verdict}`);

  const fs = require('node:fs');
  const path = require('node:path');
  const outDir = path.join(__dirname, 'evidence', 'cache001-multiinstance');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `probe-${Date.now()}.json`), JSON.stringify({ instanceA: a, instanceB: b, verdict }, null, 2));
}

main().catch((err) => {
  console.error('[cache001-multiinstance] FAILED', err);
  process.exit(1);
});
