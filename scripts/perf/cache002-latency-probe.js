'use strict';
/** PERF-CACHE-002 — probes GET /api/v1/system/health/readiness (public,
 * ThrottlerGuard-protected — the one Redis-touching global guard) N times
 * sequentially, reporting p50/p95/max latency. Used before/during a
 * concurrent campaigns.processRecipient burst to check cross-consumer Redis
 * degradation. Never imported by src/. */
const API_BASE = process.env.PERF_API_BASE || 'http://127.0.0.1:3011';
const n = Number(process.argv[2] || 30);

async function main() {
  const lat = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(`${API_BASE}/api/v1/system/health/readiness`);
    await res.text();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    lat.push({ ms, status: res.status });
  }
  lat.sort((a, b) => a.ms - b.ms);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))].ms;
  const non200 = lat.filter((l) => l.status !== 200).length;
  console.log(JSON.stringify({
    n, p50: Number(p(0.5).toFixed(2)), p95: Number(p(0.95).toFixed(2)),
    max: Number(lat[lat.length - 1].ms.toFixed(2)), non200,
  }));
}
main().catch((e) => { console.error(e); process.exit(1); });
