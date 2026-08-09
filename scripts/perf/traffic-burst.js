// T046/T047 traffic generator — populates api_logs with a real, representative
// traffic window AND records client-observed latency (MP-backend-02), paced to
// stay under the global ThrottlerGuard's 300 req/60s (real limit, NODE_ENV=development
// — see reports/environments.md). Scope-reduction disclosed: a curated sample of
// routes per class, not all 654 (throttle physics make an exhaustive sweep
// impossible inside one window; sampling per class mirrors T030's frontend approach).
const BASE = "http://127.0.0.1:3001";

async function login(email, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get("set-cookie") || "";
  // node's fetch merges multiple set-cookie into one header on some runtimes; split defensively
  const cookies = {};
  for (const part of res.headers.getSetCookie ? res.headers.getSetCookie() : [setCookie]) {
    const m = /^([^=]+)=([^;]+)/.exec(part);
    if (m) cookies[m[1]] = m[2];
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function timedGet(url, cookies) {
  const start = process.hrtime.bigint();
  let status = 0;
  try {
    const res = await fetch(url, { headers: cookies ? { Cookie: cookieHeader(cookies) } : {} });
    status = res.status;
    await res.arrayBuffer();
  } catch (e) {
    status = -1;
  }
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, status };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Logging in as perf.owner.t0@t1.local.test ...");
  const ownerCookies = await login("perf.owner.t0@t1.local.test", "PerfT1Primary123!");
  console.log("Owner login OK, cookies:", Object.keys(ownerCookies));

  // Representative routes per FR-BE-003 class. GET-only (safe/idempotent) except
  // authentication (the login call above IS that class's own representative sample).
  const routes = [
    { cls: "fast reads", path: "/api/v1/branches", auth: true },
    { cls: "fast reads", path: "/api/v1/services", auth: true },
    { cls: "standard CRUD", path: "/api/v1/appointments?limit=20", auth: true },
    { cls: "standard CRUD", path: "/api/v1/crm/customers?limit=20", auth: true },
    { cls: "authorization-heavy", path: "/api/v1/permissions", auth: true },
    { cls: "authorization-heavy", path: "/api/v1/roles", auth: true },
    { cls: "search", path: "/api/v1/crm/customers/search?q=a", auth: true },
    { cls: "dashboard aggregation", path: "/api/v1/analytics/dashboard", auth: true },
    { cls: "analytics", path: "/api/v1/analytics/dashboard", auth: true },
    { cls: "reports", path: "/api/v1/analytics/reports/daily?limit=14&page=1", auth: true },
    { cls: "AI operations", path: "/api/v1/ai/conversations?limit=20", auth: true },
    { cls: "AI operations", path: "/api/v1/ai/agents", auth: true },
    { cls: "payment operations", path: "/api/v1/invoices?limit=20", auth: true },
    { cls: "payment operations", path: "/api/v1/payments?limit=20", auth: true },
    { cls: "file/media operations", path: "/api/v1/platform/files?limit=20", auth: true },
    { cls: "public unauthenticated", path: "/api/v1/public/discovery/cities", auth: false },
    { cls: "public unauthenticated", path: "/api/v1/services/categories", auth: false },
  ];

  const REPEATS = 8; // per route — keeps total well under the 300/60s budget
  const PACE_MS = 350; // ~2.9 req/s sustained, well under 300/60=5/s

  const results = {};
  let total = 0;
  for (const r of routes) {
    results[r.cls] = results[r.cls] || [];
    for (let i = 0; i < REPEATS; i++) {
      const { ms, status } = await timedGet(BASE + r.path, r.auth ? ownerCookies : null);
      results[r.cls].push({ path: r.path, ms, status });
      total++;
      process.stdout.write(`  [${total}] ${r.cls.padEnd(24)} ${r.path.padEnd(45)} ${status} ${ms.toFixed(1)}ms\n`);
      await sleep(PACE_MS);
    }
  }

  console.log(`\nTotal requests: ${total}`);
  const fs = require("fs");
  fs.writeFileSync(
    require("path").join(__dirname, "traffic-burst-results.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), repeatsPerRoute: REPEATS, paceMs: PACE_MS, results }, null, 2),
  );
  console.log("Written to scripts/perf/traffic-burst-results.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
