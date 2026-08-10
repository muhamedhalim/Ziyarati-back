'use strict';

/**
 * PERF-INFRA-003 Stage B — Linux graceful shutdown validation. Holds one live
 * websocket connection to the clustered API open and reports exactly when
 * and why it disconnects, so a SIGTERM sent to the container from outside
 * (see docs/PERFORMANCE_INFRASTRUCTURE.md's Linux graceful-shutdown section)
 * can be judged against a REAL connection draining cleanly — Socket.IO's
 * `disconnect` reason is `"transport close"` for a server-initiated clean
 * close (what `app.close()` produces) vs `"transport error"`/an abrupt
 * ECONNRESET-style failure for a hard kill.
 *
 * Usage: node scripts/perf/infra003-linux-shutdown-ws-hold-probe.js --port=3010
 */

const { io } = require('socket.io-client');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const PORT = Number(args.port || 3010);
const base = `http://127.0.0.1:${PORT}`;
const email = args.email || 'perf.owner.t0@t1.local.test';
const password = args.password || 'PerfT1Primary123!';

async function main() {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie();
  const token = setCookie.find((c) => c.startsWith('access_token=')).split(';')[0].split('=').slice(1).join('=');

  const socket = io(`${base}/ai`, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    timeout: 8000,
  });
  socket.on('ai:connected', () => console.log(`[ws-hold] connected at ${new Date().toISOString()}`));
  socket.on('disconnect', (reason) => {
    console.log(`[ws-hold] DISCONNECTED at ${new Date().toISOString()} reason="${reason}"`);
    process.exitCode = reason === 'transport close' ? 0 : 2;
  });
  socket.on('connect_error', (err) => {
    console.log(`[ws-hold] connect_error ${err.message}`);
    process.exitCode = 1;
  });

  const t = setTimeout(() => {
    console.log('[ws-hold] TIMEOUT — never disconnected within 60s');
    process.exitCode = 1;
  }, 60000);
  t.unref();
}
main().catch((err) => {
  console.error('[ws-hold] ERROR', err);
  process.exitCode = 1;
});
