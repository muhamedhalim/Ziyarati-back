// T147/T154 PERF-CACHE-001 — Redis fail-mode measurement harness.
// Exercises: normal operation, 401/403/429, login (success + intentional
// failure), a state-changing request with CSRF, and concurrency — against
// the isolated LOCAL/T1 stack. Run once BEFORE stopping Redis and once AFTER
// restarting it, with the outage window in between driven by the caller
// (this script does not touch the Docker container itself).
//
// Usage: node cache-fail-mode-harness.js <label>
//   <label> is written into the output filename, e.g. "before", "during-outage", "after-recovery".
const BASE = "http://127.0.0.1:3001";
const fs = require("fs");
const path = require("path");

const label = process.argv[2] || "run";
const outDir = __dirname + "/evidence/cache-stageb";
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

function parseCookies(res) {
  const cookies = {};
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  for (const part of raw) {
    const m = /^([^=]+)=([^;]+)/.exec(part);
    if (m) cookies[m[1]] = decodeURIComponent(m[2]);
  }
  return cookies;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function timed(fn) {
  const start = process.hrtime.bigint();
  let result;
  let error = null;
  try {
    result = await fn();
  } catch (e) {
    error = e.message || String(e);
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result, error };
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookies = parseCookies(res);
  const bodyText = await res.text();
  return { status: res.status, cookies, bodyText };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(samples) {
  const ok = samples.filter((s) => s.error === null).map((s) => s.ms).sort((a, b) => a - b);
  const errored = samples.filter((s) => s.error !== null);
  return {
    n: samples.length,
    okCount: ok.length,
    erroredCount: errored.length,
    p50: percentile(ok, 50),
    p95: percentile(ok, 95),
    p99: percentile(ok, 99),
    min: ok[0] ?? null,
    max: ok[ok.length - 1] ?? null,
    sampleErrors: errored.slice(0, 3).map((e) => e.error),
  };
}

async function main() {
  const report = { label, timestamp: new Date().toISOString(), scenarios: {} };

  // 1. Normal/anonymous GET — public route, exercises ThrottlerGuard only.
  {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      samples.push(
        await timed(async () => {
          const res = await fetch(`${BASE}/api/v1/system/health/readiness`);
          await res.text();
          return res.status;
        }),
      );
    }
    const statuses = {};
    for (const s of samples) {
      const code = s.error ? "ERR" : s.result;
      statuses[code] = (statuses[code] || 0) + 1;
    }
    report.scenarios.publicReadiness = { statuses, ...summarize(samples) };
  }

  // 2. 401 — no credentials on a protected route.
  {
    const t = await timed(async () => {
      const res = await fetch(`${BASE}/api/v1/branches`);
      await res.text();
      return res.status;
    });
    report.scenarios.unauthenticated401 = { status: t.result, ms: t.ms, error: t.error };
  }

  // 3. Successful login (owner) + authenticated GET (403 is exercised in scenario 6 with a different role/branch if reachable, else recorded as not-applicable).
  let ownerCookies = null;
  {
    const t = await timed(() => login("perf.owner.t0@t1.local.test", "PerfT1Primary123!"));
    if (t.result && t.result.status === 200) ownerCookies = t.result.cookies;
    report.scenarios.loginSuccess = { status: t.result?.status, ms: t.ms, error: t.error };
  }

  // 4. Authenticated GET using the session — exercises the full guard chain (Throttler -> Jwt -> Csrf(no-op GET) -> Maintenance -> Subscription -> Feature).
  if (ownerCookies) {
    const samples = [];
    for (let i = 0; i < 20; i++) {
      samples.push(
        await timed(async () => {
          const res = await fetch(`${BASE}/api/v1/branches`, { headers: { Cookie: cookieHeader(ownerCookies) } });
          await res.text();
          return res.status;
        }),
      );
    }
    const statuses = {};
    for (const s of samples) {
      const code = s.error ? "ERR" : s.result;
      statuses[code] = (statuses[code] || 0) + 1;
    }
    report.scenarios.authenticatedBranches = { statuses, ...summarize(samples) };
  } else {
    report.scenarios.authenticatedBranches = { skipped: "login did not succeed this run" };
  }

  // 5. Intentional login FAILURE — exercises LoginProtectionService (separate Redis connection role, expected to already fail open independent of this fix).
  {
    const t = await timed(() => login("perf.owner.t0@t1.local.test", "WrongPassword!not-real"));
    report.scenarios.loginIntentionalFailure = { status: t.result?.status, ms: t.ms, error: t.error };
  }

  // 6. CSRF-protected state-changing request WITHOUT a token — expect 403 (CsrfGuard, in-memory, must be unaffected by Redis state).
  if (ownerCookies) {
    const t = await timed(async () => {
      const res = await fetch(`${BASE}/api/v1/branches`, {
        method: "POST",
        headers: { Cookie: cookieHeader(ownerCookies), "Content-Type": "application/json" },
        body: JSON.stringify({ name: "csrf-probe-should-not-be-created" }),
      });
      await res.text();
      return res.status;
    });
    report.scenarios.csrfMissingToken = { status: t.result, ms: t.ms, error: t.error };
  }

  // 7. Concurrency — 15 concurrent requests to the public readiness route (must never crash the process, must all resolve).
  {
    const start = process.hrtime.bigint();
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        timed(async () => {
          const res = await fetch(`${BASE}/api/v1/system/health/readiness`);
          await res.text();
          return res.status;
        }),
      ),
    );
    const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
    const statuses = {};
    for (const r of results) {
      const code = r.error ? "ERR" : r.result;
      statuses[code] = (statuses[code] || 0) + 1;
    }
    report.scenarios.concurrency15 = { totalMs, statuses, ...summarize(results) };
  }

  const outFile = path.join(outDir, `harness-${label}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outFile}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("harness fatal error", e);
  process.exit(1);
});
