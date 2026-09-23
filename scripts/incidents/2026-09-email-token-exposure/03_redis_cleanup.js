/*
 * INCIDENT 2026-09 — raw credential tokens used as BullMQ job ids.
 * 03: REDIS CLEANUP. Runs INSIDE the worker container (Redis is private-network
 * only), using the app's own REDIS_URL / DATABASE_URL / DB_SSL_CA_CERT.
 *
 *   DRY RUN (default — reads only):
 *     railway ssh -s ziyarati-worker-production -- "cd /app && node -e \"eval(Buffer.from('<base64 of this file>','base64').toString())\""
 *   APPLY: same, with `APPLY=1 node -e ...`
 *
 * Prints COUNTS ONLY — never a job id, token, hash or payload.
 *
 * Scope (nothing else is touched; Redis is never flushed):
 *   * Queue `email` only — the only queue whose job ids were built from tokens.
 *   * A job id is RAW when it is `email-(invite|reset|verify)_<64 hex>` and the
 *     64-hex tail is NOT a current password_resets.token_hash (post-fix ids ARE
 *     the token_hash). Same rule as 02_remediation.sql.
 *   * Raw-id jobs are removed only when COMPLETED or FAILED. A raw-id job that is
 *     waiting/active/delayed/prioritized/paused is reported and left alone.
 *   * `bull:email:events` stream entries whose jobId is raw are XDEL'd. The
 *     stream is observability only (QueueEvents); no job state lives in it.
 */
const Redis = require('ioredis');
const { Client } = require('pg');

const APPLY = process.env.APPLY === '1';
const CRED_ID = /^email-(invite|reset|verify)_([0-9a-f]{64})$/;

async function tokenHashes() {
  const ca = process.env.DB_SSL_CA_CERT;
  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: ca ? { ca, rejectUnauthorized: true } : undefined,
    options: '-c default_transaction_read_only=on',
  });
  await pg.connect();
  try {
    const { rows } = await pg.query('SELECT token_hash FROM password_resets');
    return new Set(rows.map((r) => r.token_hash));
  } finally {
    await pg.end();
  }
}

(async () => {
  const hashes = await tokenHashes();
  const isRaw = (id) => {
    const m = CRED_ID.exec(id);
    return Boolean(m) && !hashes.has(m[2]);
  };

  const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  const P = (process.env.QUEUE_ENV_PREFIX || '').trim() || 'bull';
  const Q = `${P}:email`;
  const report = { mode: APPLY ? 'APPLY' : 'DRY_RUN', prefix: P };

  // Jobs by state.
  const removable = [];
  const pendingRaw = {};
  const hashedKept = {};
  for (const [state, kind] of [
    ['completed', 'zset'], ['failed', 'zset'],
    ['wait', 'list'], ['active', 'list'], ['paused', 'list'],
    ['delayed', 'zset'], ['prioritized', 'zset'],
  ]) {
    const key = `${Q}:${state}`;
    const ids = kind === 'list' ? await r.lrange(key, 0, -1) : await r.zrange(key, 0, -1);
    for (const id of ids) {
      if (!CRED_ID.test(id)) continue;
      if (!isRaw(id)) { hashedKept[state] = (hashedKept[state] || 0) + 1; continue; }
      if (state === 'completed' || state === 'failed') removable.push({ id, state });
      else pendingRaw[state] = (pendingRaw[state] || 0) + 1;
    }
  }
  report.rawJobsToRemove = removable.reduce((a, j) => ({ ...a, [j.state]: (a[j.state] || 0) + 1 }), {});
  report.rawJobsPendingLeftAlone = pendingRaw;
  report.hashedCredentialJobsKept = hashedKept;

  // Events stream entries referencing a raw id.
  const evKey = `${Q}:events`;
  const entries = await r.xrange(evKey, '-', '+');
  const rawEntryIds = [];
  for (const [entryId, fields] of entries) {
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === 'jobId' && isRaw(fields[i + 1])) { rawEntryIds.push(entryId); break; }
    }
  }
  report.eventsStreamLength = entries.length;
  report.eventsEntriesToDelete = rawEntryIds.length;

  if (APPLY) {
    let removed = 0;
    for (const { id, state } of removable) {
      // BullMQ's own removeJob Lua script is what Job.remove() calls; here we
      // do the same three things explicitly: drop from the state set, delete
      // the job hash and its logs list. Re-checks the state first.
      const stillThere = await r.zscore(`${Q}:${state}`, id);
      if (stillThere === null) continue;
      await r.multi()
        .zrem(`${Q}:${state}`, id)
        .del(`${Q}:${id}`, `${Q}:${id}:logs`)
        .exec();
      removed++;
    }
    let xdel = 0;
    for (let i = 0; i < rawEntryIds.length; i += 500) {
      xdel += await r.xdel(evKey, ...rawEntryIds.slice(i, i + 500));
    }
    report.applied = { jobsRemoved: removed, eventsDeleted: xdel };
  }

  // Post-check (both modes): what raw references remain?
  let remainingKeys = 0;
  let cursor = '0';
  do {
    const [c, keys] = await r.scan(cursor, 'MATCH', `${Q}:*`, 'COUNT', 1000);
    cursor = c;
    for (const k of keys) {
      const id = k.slice(Q.length + 1).split(':')[0];
      if (isRaw(id)) remainingKeys++;
    }
  } while (cursor !== '0');
  report.rawKeyNamesRemaining = remainingKeys;

  console.log(JSON.stringify(report, null, 1));
  r.disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
