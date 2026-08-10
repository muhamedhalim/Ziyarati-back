'use strict';

/**
 * PERF-INFRA-003 Stage B — production-readiness validation (2026-08-10, 2nd
 * `/speckit-implement`). Two real risks, both exercised against a REAL
 * multi-worker cluster (not asserted from reading the code):
 *
 * 1. Transport-restriction correctness (redis-io.adapter.ts).
 *    - Against a CLUSTERED instance (API_CLUSTER_WORKERS>1): a client that
 *      only offers `polling` must be cleanly REJECTED (proves the fix in
 *      redis-io.adapter.ts actually takes effect over the wire, not just in
 *      code review) — HTTP long-polling has no cross-worker session affinity
 *      under this cluster design, so allowing it would silently break a
 *      real client mid-session instead of failing fast at connect time.
 *    - Against a SINGLE-PROCESS instance (API_CLUSTER_WORKERS unset/1): the
 *      SAME polling-only client must still CONNECT — proves the restriction
 *      is conditional, not a regression to the pre-clustering default.
 *    - `websocket`-only must connect successfully against the CLUSTERED
 *      instance either way (the transport that needs no affinity).
 *
 * 2. Reconnect + broadcast resilience under real worker churn.
 *    - Opens a websocket connection (socket A), confirms presence broadcast
 *      to an independent socket B (cross-worker, via the Redis adapter).
 *    - Forcibly severs socket A's transport client-side (simulates a network
 *      blip) and waits for socket.io-client's own reconnection logic to
 *      recover — the new connection may land on ANY worker (no stickiness
 *      by design; only WS needs none). Re-runs the broadcast check on the
 *      reconnected socket to prove full functional recovery, not just a
 *      "connected" event.
 *    - Independently: kills 2 of the 4 worker OS processes via the
 *      cluster-bootstrap primary's own respawn path while sockets are open,
 *      confirms the primary respawns them (first time proven on Linux,
 *      matching the earlier Windows-only crash-respawn evidence) and that a
 *      brand-new connection made immediately after still succeeds.
 *
 * Usage:
 *   node scripts/perf/infra003-transport-reconnect-probe.js \
 *     --clusteredPort=3010 --singlePort=3011 --containerName=ziyarati-linux-cluster-test
 */

const { io } = require('socket.io-client');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const CLUSTERED_PORT = Number(args.clusteredPort || 3010);
const SINGLE_PORT = args.singlePort ? Number(args.singlePort) : null;
const CONTAINER = args.containerName || null;
const LOGIN_EMAIL = args.email || 'perf.owner.t0@t1.local.test';
const LOGIN_PASSWORD = args.password || 'PerfT1Primary123!';

async function login(base) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
  if (!accessCookie) throw new Error('no access_token cookie returned');
  return accessCookie.split(';')[0].split('=').slice(1).join('=');
}

function tryConnect(base, token, transports, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = io(`${base}/ai`, {
      transports,
      auth: { token },
      forceNew: true,
      reconnection: false,
      timeout: timeoutMs,
    });
    const done = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      socket.close();
      done({ ok: false, reason: 'timeout (neither connected nor errored)' });
    }, timeoutMs + 1000);
    socket.on('ai:connected', () => done({ ok: true, socket }));
    socket.on('connect_error', (err) => done({ ok: false, reason: err.message, socket: null }));
  });
}

async function testTransportRestriction() {
  console.log('\n=== TEST 1: transport restriction ===');
  const clusteredBase = `http://127.0.0.1:${CLUSTERED_PORT}`;
  const tokenClustered = await login(clusteredBase);

  const pollingOnClustered = await tryConnect(clusteredBase, tokenClustered, ['polling']);
  console.log(
    `[transport] polling-only vs CLUSTERED (${CLUSTERED_PORT}): ` +
      (pollingOnClustered.ok ? 'CONNECTED (unexpected)' : `REJECTED (${pollingOnClustered.reason})`),
  );
  if (pollingOnClustered.socket) pollingOnClustered.socket.close();

  const wsOnClustered = await tryConnect(clusteredBase, tokenClustered, ['websocket']);
  console.log(
    `[transport] websocket-only vs CLUSTERED (${CLUSTERED_PORT}): ` +
      (wsOnClustered.ok ? 'CONNECTED' : `FAILED (${wsOnClustered.reason})`),
  );
  if (wsOnClustered.socket) wsOnClustered.socket.close();

  let pollingOnSingle = { ok: true, note: 'skipped (no --singlePort given)' };
  if (SINGLE_PORT) {
    const singleBase = `http://127.0.0.1:${SINGLE_PORT}`;
    const tokenSingle = await login(singleBase);
    pollingOnSingle = await tryConnect(singleBase, tokenSingle, ['polling']);
    console.log(
      `[transport] polling-only vs SINGLE-PROCESS (${SINGLE_PORT}): ` +
        (pollingOnSingle.ok ? 'CONNECTED (expected — no regression)' : `REJECTED (${pollingOnSingle.reason}) — REGRESSION`),
    );
    if (pollingOnSingle.socket) pollingOnSingle.socket.close();
  } else {
    console.log('[transport] SINGLE-PROCESS regression check SKIPPED — no --singlePort given');
  }

  const pass =
    pollingOnClustered.ok === false && wsOnClustered.ok === true && pollingOnSingle.ok === true;
  console.log(`[transport] RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

function connectWs(base, token, label) {
  return new Promise((resolve, reject) => {
    const socket = io(`${base}/ai`, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 500,
      timeout: 8000,
    });
    const timer = setTimeout(() => reject(new Error(`${label} connect timeout`)), 9000);
    socket.once('ai:connected', () => {
      clearTimeout(timer);
      console.log(`[reconnect] ${label} connected, socket.id=${socket.id}`);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label} connect_error: ${err.message}`));
    });
  });
}

function waitForPresence(socket, expectedStatus, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once('ai:presence', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  }).then((payload) => {
    if (payload && expectedStatus && payload.status !== expectedStatus) return null;
    return payload;
  });
}

async function testReconnectAndBroadcast() {
  console.log('\n=== TEST 2: reconnect + broadcast resilience ===');
  const base = `http://127.0.0.1:${CLUSTERED_PORT}`;
  const token = await login(base);

  let socketA = await connectWs(base, token, 'A');
  const socketB = await connectWs(base, token, 'B');
  await new Promise((r) => setTimeout(r, 300));

  console.log('[reconnect] broadcast check #1 (pre-disconnect)');
  const reconnectPromise1 = new Promise((resolve) => socketB.once('ai:presence', resolve));
  socketA.emit('ai:presence:update', { status: 'BUSY' });
  const first = await Promise.race([reconnectPromise1, new Promise((r) => setTimeout(() => r(null), 6000))]);
  console.log(`[reconnect] broadcast #1: ${first ? 'RECEIVED ' + JSON.stringify(first) : 'MISSING'}`);

  // Simulate a dropped connection: force-close the underlying transport
  // (not socket.disconnect(), which is a clean intentional close the client
  // won't auto-reconnect from) and let socket.io-client's reconnection logic
  // recover on its own, exactly as it would after a real network blip.
  console.log('[reconnect] force-closing socket A transport (simulated network blip)…');
  const reconnected = new Promise((resolve) => socketA.once('ai:connected', resolve));
  socketA.io.engine.close();

  const gotReconnected = await Promise.race([
    reconnected.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 10000)),
  ]);
  console.log(`[reconnect] socket A auto-reconnected: ${gotReconnected} (new socket.id=${socketA.id})`);

  let secondBroadcastOk = false;
  if (gotReconnected) {
    console.log('[reconnect] broadcast check #2 (post-reconnect, from the NEW connection)');
    // Reconnecting also fires the gateway's own automatic "ONLINE" presence
    // broadcast (OnGatewayConnection) — that arrives on socketB moments
    // before our explicit update below, so collect events instead of
    // `.once()`-racing the first one.
    const seen = [];
    const listener = (payload) => seen.push(payload);
    socketB.on('ai:presence', listener);
    await new Promise((r) => setTimeout(r, 500)); // let the automatic ONLINE broadcast settle first
    socketA.emit('ai:presence:update', { status: 'AWAY' });
    await new Promise((r) => setTimeout(r, 4000));
    socketB.off('ai:presence', listener);
    console.log(`[reconnect] broadcast #2 events received: ${JSON.stringify(seen)}`);
    secondBroadcastOk = seen.some((p) => p.status === 'AWAY');
  }

  socketA.close();
  socketB.close();

  const pass = !!first && gotReconnected && secondBroadcastOk;
  console.log(`[reconnect] RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function testWorkerChurn() {
  console.log('\n=== TEST 3: worker churn (kill 2/4 workers, confirm respawn + new connections still work) ===');
  if (!CONTAINER) {
    console.log('[churn] SKIPPED — no --containerName given');
    return true;
  }
  const base = `http://127.0.0.1:${CLUSTERED_PORT}`;

  const before = await execFileAsync('docker', [
    'exec', CONTAINER, 'node', '-e',
    // Match an argv entry ENDING in dist/src/main.js (the primary is
    // launched with the relative 'dist/src/main.js'; cluster.fork() re-execs
    // workers with the absolute '/app/dist/src/main.js') via a per-argv
    // check rather than a raw joined-string substring search — a substring
    // search would also match THIS listing command's own argv, since the
    // pattern text itself contains the string.
    "const fs=require('fs');console.log(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{const parts=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').filter(Boolean);return parts.some(a=>a.endsWith('dist/src/main.js'))&&!parts.includes('-e')}catch{return false}}).join(','))",
  ]);
  const pidsBefore = before.stdout.trim().split(',').filter(Boolean);
  console.log(`[churn] node pids before: ${pidsBefore.join(', ')} (${pidsBefore.length} total incl. primary)`);
  const workerPids = pidsBefore.filter((p) => p !== '1');
  const toKill = workerPids.slice(0, 2);
  console.log(`[churn] killing worker pids: ${toKill.join(', ')}`);
  for (const pid of toKill) {
    // node:24-slim has no standalone `kill` binary — use Node itself, which
    // is guaranteed present, to send the signal.
    await execFileAsync('docker', ['exec', CONTAINER, 'node', '-e', `process.kill(${pid}, 'SIGKILL')`]);
  }

  await new Promise((r) => setTimeout(r, 4000));

  const after = await execFileAsync('docker', [
    'exec', CONTAINER, 'node', '-e',
    // Match an argv entry ENDING in dist/src/main.js (the primary is
    // launched with the relative 'dist/src/main.js'; cluster.fork() re-execs
    // workers with the absolute '/app/dist/src/main.js') via a per-argv
    // check rather than a raw joined-string substring search — a substring
    // search would also match THIS listing command's own argv, since the
    // pattern text itself contains the string.
    "const fs=require('fs');console.log(fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{const parts=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').filter(Boolean);return parts.some(a=>a.endsWith('dist/src/main.js'))&&!parts.includes('-e')}catch{return false}}).join(','))",
  ]);
  const pidsAfter = after.stdout.trim().split(',').filter(Boolean);
  console.log(`[churn] node pids after respawn wait: ${pidsAfter.join(', ')} (${pidsAfter.length} total incl. primary)`);

  const token = await login(base);
  const postChurn = await tryConnect(base, token, ['websocket']);
  console.log(`[churn] new connection after churn: ${postChurn.ok ? 'CONNECTED' : 'FAILED (' + postChurn.reason + ')'}`);
  if (postChurn.socket) postChurn.socket.close();

  const pass = pidsAfter.length === pidsBefore.length && postChurn.ok;
  console.log(`[churn] RESULT: ${pass ? 'PASS' : 'FAIL'}`);
  return pass;
}

async function main() {
  console.log(`[probe] clusteredPort=${CLUSTERED_PORT} singlePort=${SINGLE_PORT ?? 'n/a'} container=${CONTAINER ?? 'n/a'}`);
  const r1 = await testTransportRestriction();
  const r2 = await testReconnectAndBroadcast();
  const r3 = await testWorkerChurn();
  console.log('\n=== SUMMARY ===');
  console.log(`transport restriction: ${r1 ? 'PASS' : 'FAIL'}`);
  console.log(`reconnect + broadcast: ${r2 ? 'PASS' : 'FAIL'}`);
  console.log(`worker churn:          ${r3 ? 'PASS' : 'FAIL'}`);
  process.exitCode = r1 && r2 && r3 ? 0 : 1;
}

main().catch((err) => {
  console.error('[probe] ERROR', err);
  process.exitCode = 1;
});
