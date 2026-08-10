'use strict';

/**
 * T058 / PERF-CACHE-002 — seeds a REAL, safe campaign-dispatch backlog on the
 * isolated `ziyarati-perfaudit` stack (5434/6380) only, then bulk-enqueues
 * `campaigns.processRecipient` jobs so the real worker can process them.
 *
 * Safety (Standing Rule 9 — no real recipient message, no real financial
 * operation): the seeded Campaign has `template = NULL`. Every recipient a
 * real dispatch attempts hits `WhatsappCampaignDeliveryProvider.send()`'s
 * OWN first check — `if (!payload.templateId) return { success: false,
 * error: 'no template' }` — which returns before any WhatsApp/Meta network
 * call. This still exercises the full realistic DB+Redis path a real send
 * would (claim UPDATE, run lookup, campaign+template join, consent check,
 * TenantRateLimiterService.consume against Redis), just not the outbound
 * HTTP leg — exactly the class of measurement this task needs (queue
 * throughput / DB pool contention under WORKER_ROLE split), not a message
 * delivery test.
 *
 * Never imported by src/ — standalone, run directly with node.
 *
 * Usage:
 *   node scripts/perf/t058-seed-and-enqueue.js --count=2000
 */

const { Client } = require('pg');
const { Queue } = require('bullmq');
const { randomUUID } = require('node:crypto');

const PG_CONN = process.env.PERF_PG_CONN || 'postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf';
const REDIS_HOST = process.env.PERF_REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.PERF_REDIS_PORT || 6380);

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const TENANTS = Number(args.tenants || 1);
const PER_TENANT = Number(args.count || 2000);

async function seedOneTenant(pg, queue, tenantId) {
  const customersRes = await pg.query(
    `SELECT id FROM customers WHERE "tenantId" = $1 AND phone IS NOT NULL ORDER BY id LIMIT $2`,
    [tenantId, PER_TENANT],
  );
  if (customersRes.rows.length === 0) return { tenantId, recipients: 0 };
  const customerIds = customersRes.rows.map((r) => r.id);

  // Opt these fixture customers into marketing so the dispatch flow reaches
  // the rate-limiter (Redis) step instead of stopping at the consent check —
  // needed for PERF-CACHE-002's cross-consumer Redis measurement. Isolated
  // LOCAL fixture data only, reversible, never real customers.
  await pg.query(
    `UPDATE customers SET marketing_opt_in = true, opted_out_at = NULL WHERE id = ANY($1::uuid[])`,
    [customerIds],
  );

  const campaignId = randomUUID();
  const runId = randomUUID();
  const idempotencyKey = randomUUID();

  // channel/type enums: confirmed via src/entities/enums.ts CampaignType/CampaignExecution.
  // throttle_per_minute set high so the PER-TENANT rate limiter (a business
  // rule, separate from CAMPAIGN_DISPATCH_CONCURRENCY) is not the bottleneck
  // being measured here — this test isolates queue-concurrency/DB-pool
  // behavior, not per-tenant send-rate policy.
  await pg.query(
    `INSERT INTO campaigns (id, "tenantId", type, name, lifecycle, throttle_per_minute, created_at, updated_at)
     VALUES ($1, $2, 'CUSTOM', $3, 'ACTIVE', 100000, now(), now())`,
    [campaignId, tenantId, 'PERF-T058 dispatch-backlog (no template — safe, no real send)'],
  );
  await pg.query(
    `INSERT INTO campaign_runs (id, "tenantId", "campaignId", execution, total_recipients, idempotency_key, version, started_at, created_at)
     VALUES ($1, $2, $3, 'PROCESSING', $4, $5, 1, now(), now())`,
    [runId, tenantId, campaignId, customerIds.length, idempotencyKey],
  );

  const recipientRows = customerIds.map((cid) => ({ id: randomUUID(), customerId: cid }));
  const CHUNK = 1000;
  for (let i = 0; i < recipientRows.length; i += CHUNK) {
    const chunk = recipientRows.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    chunk.forEach((r, idx) => {
      const base = idx * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 'PENDING', 'NONE', now())`);
      params.push(r.id, runId, campaignId, r.customerId);
    });
    await pg.query(
      `INSERT INTO campaign_recipients (id, "runId", "campaignId", "customerId", processing, delivery, created_at) VALUES ${values.join(',')}`,
      params,
    );
  }

  const jobs = recipientRows.map((r) => ({
    name: 'campaigns.processRecipient',
    data: { tenantId, campaignId, runId, recipientId: r.id, correlationId: `perf-t058-${r.id}` },
    opts: { jobId: `campaign-recipient-${runId}-${r.id}` },
  }));
  const BULK_CHUNK = 500;
  for (let i = 0; i < jobs.length; i += BULK_CHUNK) {
    await queue.addBulk(jobs.slice(i, i + BULK_CHUNK));
  }
  console.log(`tenant=${tenantId} campaign=${campaignId} run=${runId} recipients=${recipientRows.length}`);
  return { tenantId, campaignId, runId, recipients: recipientRows.length };
}

async function main() {
  const pg = new Client({ connectionString: PG_CONN });
  await pg.connect();

  const tenantRes = await pg.query(
    `SELECT id FROM tenants WHERE is_active = true AND approval_status = 'APPROVED' ORDER BY id LIMIT $1`,
    [TENANTS],
  );
  if (tenantRes.rows.length === 0) throw new Error('no active tenant found — is T1 seeded?');

  const queue = new Queue('campaigns.processRecipient', {
    connection: { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 20 },
  });

  const results = [];
  for (const row of tenantRes.rows) {
    results.push(await seedOneTenant(pg, queue, row.id));
  }
  const totalRecipients = results.reduce((s, r) => s + r.recipients, 0);
  console.log(`TOTAL enqueued across ${results.length} tenant(s): ${totalRecipients} jobs`);

  await queue.close();
  await pg.end();

  console.log(JSON.stringify({ results, totalRecipients }));
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
