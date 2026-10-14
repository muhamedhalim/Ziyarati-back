#!/usr/bin/env node
/**
 * End-to-end log ingestion check (LOGGING.md §Verification).
 *
 * Proves that a log line written by the RUNNING application reaches the
 * CENTRAL STORE through the real collector — not that the logger prints
 * something to a console:
 *
 *   app container stdout → Docker json-file → Alloy → Loki   (queried over HTTP)
 *
 * 1. sends one request with a known, unique X-Request-ID to a protected route
 *    without credentials — a deterministic, side-effect-free failure (401:
 *    the guard rejects it before any handler, DB write or provider call);
 * 2. polls Loki for that request_id until the lines arrive (or times out);
 * 3. asserts the access line AND the security event are there, with the
 *    schema fields, and that no identity/high-cardinality field became a label;
 * 4. if the line carries a trace_id, checks that Tempo has that trace (soft).
 *
 * Exit code 0 = verified, 1 = failed, 2 = environment not reachable (BLOCKED).
 *
 * Usage (stack up, see LOGGING.md §Local stack):
 *   node scripts/observability/verify-log-ingestion.mjs
 * Env: API_URL (default http://127.0.0.1:3300), LOKI_URL (http://127.0.0.1:3100),
 *      TEMPO_URL (http://127.0.0.1:3200), VERIFY_TIMEOUT_MS (90000)
 */
import { randomUUID } from 'node:crypto';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:3300';
const LOKI_URL = process.env.LOKI_URL ?? 'http://127.0.0.1:3100';
const TEMPO_URL = process.env.TEMPO_URL ?? 'http://127.0.0.1:3200';
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 90_000);
const PROTECTED_ROUTE = '/api/v1/appointments';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

async function reachable(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function lokiQuery(logql, startNs) {
  const params = new URLSearchParams({
    query: logql,
    start: String(startNs),
    end: String(BigInt(Date.now() + 60_000) * 1_000_000n),
    limit: '100',
    direction: 'forward',
  });
  const res = await fetch(`${LOKI_URL}/loki/api/v1/query_range?${params}`);
  if (!res.ok) throw new Error(`Loki query failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return body.data.result.flatMap((stream) =>
    stream.values.map(([, line]) => ({ labels: stream.stream, record: safeJson(line) })),
  );
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { _unparsed: line };
  }
}

async function main() {
  if (!(await reachable(`${LOKI_URL}/ready`))) {
    console.log(`BLOCKED  Loki not reachable at ${LOKI_URL}`);
    process.exit(2);
  }
  if (!(await reachable(`${API_URL}/api/v1/health`))) {
    console.log(`BLOCKED  API not reachable at ${API_URL}`);
    process.exit(2);
  }

  const requestId = `verify-${randomUUID()}`;
  const startNs = BigInt(Date.now() - 60_000) * 1_000_000n;
  console.log(`request_id = ${requestId}`);

  const res = await fetch(`${API_URL}${PROTECTED_ROUTE}`, { headers: { 'X-Request-ID': requestId } });
  await res.text();
  check('API returned the expected synthetic failure (401)', res.status === 401, `HTTP ${res.status}`);
  check('API echoed the X-Request-ID', res.headers.get('x-request-id') === requestId);

  const logql = `{service="ziyaratech-api"} | json | request_id="${requestId}"`;
  let lines = [];
  const deadline = Date.now() + TIMEOUT_MS;
  const t0 = Date.now();
  while (Date.now() < deadline) {
    lines = await lokiQuery(logql, startNs);
    const events = new Set(lines.map((l) => l.record.event));
    if (events.has('http.request.completed') && events.has('auth.authentication.failed')) break;
    await sleep(2000);
  }
  const latencyMs = Date.now() - t0;

  const access = lines.find((l) => l.record.event === 'http.request.completed');
  const security = lines.find((l) => l.record.event === 'auth.authentication.failed');
  check('access line reached Loki', !!access, `${lines.length} line(s) for this request_id after ${latencyMs} ms`);
  check('security event reached Loki', !!security);

  if (access) {
    const r = access.record;
    check('access line has the schema fields', ['timestamp', 'level', 'service', 'env', 'version', 'event', 'message', 'request_id', 'duration_ms']
      .every((k) => r[k] !== undefined), JSON.stringify({ level: r.level, version: r.version, env: r.env }));
    check('access line uses the route template, status 401', r.route === PROTECTED_ROUTE && r.status === 401, `${r.method} ${r.route} ${r.status}`);
    check('timestamp is UTC ISO-8601 with ms', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.timestamp));
    // Raw stream labels: a line-filter query (no `| json`, which would add
    // query-time parsed fields to the result's label set).
    const raw = await lokiQuery(`{service="ziyaratech-api"} |= "${requestId}"`, startNs);
    const labelKeys = [...new Set(raw.flatMap((l) => Object.keys(l.labels)))].sort();
    check('stream labels are exactly service/env/level', labelKeys.join(',') === 'env,level,service', labelKeys.join(','));
  }
  if (security) {
    check('security event is warn and carries client_ip', security.record.level === 'warn' && typeof security.record.client_ip === 'string');
  }

  const labelsRes = await fetch(
    `${LOKI_URL}/loki/api/v1/labels?start=${startNs}&end=${BigInt(Date.now() + 60_000) * 1_000_000n}`,
  );
  const allLabels = (await labelsRes.json()).data ?? [];
  check('no identity / request field is a Loki label anywhere',
    !allLabels.some((l) => ['request_id', 'user_id', 'tenant_id', 'trace_id', 'span_id', 'job_id', 'client_ip'].includes(l)),
    allLabels.join(','));

  const traceId = access?.record.trace_id ?? security?.record.trace_id;
  if (traceId) {
    let found = false;
    for (let i = 0; i < 15 && !found; i++) {
      const t = await fetch(`${TEMPO_URL}/api/traces/${traceId}`).catch(() => null);
      found = !!t && t.ok;
      if (!found) await sleep(2000);
    }
    console.log(`${found ? 'PASS' : 'WARN'}  trace ${traceId} ${found ? 'found in Tempo (log ↔ trace correlation)' : 'not (yet) in Tempo — soft check'}`);
  } else {
    console.log('INFO  no trace_id on the line (tracing disabled or request not sampled)');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'VERIFIED' : 'FAILED'}: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERROR  ${err?.message ?? err}`);
  process.exit(1);
});
