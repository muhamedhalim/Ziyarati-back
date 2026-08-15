/**
 * T128 — webhook verification for the AI-adjacent inbound path that feeds
 * the AI (WhatsApp — the only inbound-webhook-driven AI channel in this
 * codebase; see `WhatsappWebhookController`/`WhatsappWebhookService`),
 * FR-069: signature validation and tenant mapping resolved from stored
 * records, not payload content.
 *
 * `WhatsappWebhookService.ingest()` (whatsapp-webhook.service.ts:126-133)
 * calls `WebhookSignatureVerifier.verify()` and throws `UNAUTHORIZED`
 * BEFORE `resolveTenantFromPayload()` ever runs (line 163) — verified here
 * both by driving the real route and by confirming NO tenant-resolution
 * side effect (a stored `whatsapp_webhooks` row referencing a tenant) exists
 * for a rejected event.
 */
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { WhatsappAccount } from '../../src/entities/WhatsApp/WhatsappAccount';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

const ROUTE = '/api/v1/whatsapp/webhooks/events';

function metaPayload(phoneNumberId: string) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              // `timestamp` (Unix seconds) is required by ZT-H02's
              // enforceEventFreshness check, which runs AFTER signature
              // verification (whatsapp-webhook.service.ts:148) — a fresh
              // timestamp here isolates the signature-verification gate
              // itself as the thing under test, rather than incidentally
              // exercising the freshness gate too.
              messages: [
                {
                  id: `wamid.${randomUUID()}`,
                  from: '15551234567',
                  type: 'text',
                  text: { body: 'hello' },
                  timestamp: String(Math.floor(Date.now() / 1000)),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('W8 — WhatsApp webhook signature verification gates tenant resolution (T128)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let phoneNumberId: string;
  let appSecret: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    appSecret = harness.config.getOrThrow<string>('META_APP_SECRET');
    phoneNumberId = `w8-t128-${randomUUID().slice(0, 8)}`;

    const accounts = harness.dataSource.getRepository(WhatsappAccount);
    await accounts.save(
      accounts.create({
        tenant: { id: seed.tenantA.id } as Tenant,
        phone_number_id: phoneNumberId,
        is_active: true,
        connection_status: 'CONNECTED',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM whatsapp_webhooks WHERE "tenantId" = $1`, [seed.tenantA.id]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM whatsapp_accounts WHERE "tenantId" = $1`, [seed.tenantA.id]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('UNSIGNED payload — rejected 401, no whatsapp_webhooks row created, tenant never resolved', async () => {
    const before = await harness.dataSource.query(`SELECT COUNT(*)::int AS c FROM whatsapp_webhooks WHERE "tenantId" = $1`, [seed.tenantA.id]);
    const body = metaPayload(phoneNumberId);

    const res = await request(harness.app.getHttpServer()).post(ROUTE).send(body);
    // No X-Hub-Signature-256 header at all.
    expect(res.status).toBe(401);

    const after = await harness.dataSource.query(`SELECT COUNT(*)::int AS c FROM whatsapp_webhooks WHERE "tenantId" = $1`, [seed.tenantA.id]);
    expect(after[0].c).toBe(before[0].c);
  }, 30_000);

  it('WRONGLY-SIGNED payload (garbage signature) — rejected 401, no whatsapp_webhooks row created, tenant never resolved', async () => {
    const before = await harness.dataSource.query(`SELECT COUNT(*)::int AS c FROM whatsapp_webhooks WHERE "tenantId" = $1`, [seed.tenantA.id]);
    const body = metaPayload(phoneNumberId);

    const res = await request(harness.app.getHttpServer())
      .post(ROUTE)
      .set('X-Hub-Signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
      .send(body);
    expect(res.status).toBe(401);

    const after = await harness.dataSource.query(`SELECT COUNT(*)::int AS c FROM whatsapp_webhooks WHERE "tenantId" = $1`, [seed.tenantA.id]);
    expect(after[0].c).toBe(before[0].c);
  }, 30_000);

  it('WRONGLY-SIGNED payload (signed with the WRONG secret, right shape) — rejected 401', async () => {
    const body = metaPayload(phoneNumberId);
    const raw = Buffer.from(JSON.stringify(body));
    const wrongSignature = `sha256=${createHmac('sha256', 'definitely-not-the-real-app-secret').update(raw).digest('hex')}`;

    const res = await request(harness.app.getHttpServer())
      .post(ROUTE)
      .set('X-Hub-Signature-256', wrongSignature)
      .send(body);
    expect(res.status).toBe(401);
  }, 30_000);

  it('CORRECTLY-signed payload — accepted, and the tenant IS resolved, from the STORED WhatsappAccount mapping (not from any tenant field in the payload — there is none)', async () => {
    // supertest's .send(obj) internally JSON.stringify()s using the SAME
    // key order this object literal declares (Node's own JSON.stringify),
    // so hashing the identical stringify output here reproduces the exact
    // raw bytes Meta's HMAC would cover.
    const body = metaPayload(phoneNumberId);
    const raw = Buffer.from(JSON.stringify(body));
    const validSignature = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;

    const res = await request(harness.app.getHttpServer())
      .post(ROUTE)
      .set('X-Hub-Signature-256', validSignature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    const rows = await harness.dataSource.query(
      `SELECT "tenantId" FROM whatsapp_webhooks WHERE id = $1`,
      [res.body.id],
    );
    // Tenant mapping came from the STORED WhatsappAccount row keyed on
    // phone_number_id — the payload itself carries no tenant identifier at all.
    expect(rows[0]?.tenantId).toBe(seed.tenantA.id);
  }, 30_000);
});
