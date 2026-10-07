/**
 * WhatsApp pipeline, end to end: signed Meta webhook → ingest → queue row →
 * `processEvent` → inbound bridge → policy → AI turn → outbound send.
 *
 * Unlike det-02/det-08 (which call `handleInboundValue` directly), this drives the
 * REAL edge: HMAC verification, tenant resolution from `phone_number_id`, dedupe,
 * batch splitting and the per-contact lock. Every clinic has a connected account
 * (seeded in `audit-seed.ts`), so timeline storage and account routing run for
 * real. Only the outbound Meta send is captured, and the "model" is a double.
 *
 * Scenarios (IDs follow the audit plan, section G):
 *   SIG-1    bad signature → 401, no row
 *   ROUTE-1  a message to a clinic's SECOND number is answered from that account
 *   DUP-1    the same wamid delivered twice → one row, one reply
 *   DUP-2    the same event processed twice → still one reply
 *   DUP-3    a batched POST → one row per change, each its own tenant; unknown number tenant-less
 *   CONC-1   two first messages processed in parallel → ONE AI session, two replies
 *   OOS-1    an Arabic code request is redirected without a model call
 *   BOOK-1   every turn's prompt carries the server-stated date
 *   CLINIC-1 bot_enabled=false → stored, not answered, no model call
 *   HT-1     a human-takeover window → stored, not answered, no model call
 *   FAIL-1   a provider failure → exactly one fallback, none of its internals
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { bootAudit, type AuditRuntime } from './fixtures/audit-runtime';
import { WhatsappWebhookService } from '../../src/modules/whatsapp/whatsapp-webhook.service';
import { WhatsappMessagingService } from '../../src/modules/whatsapp/whatsapp-messaging.service';
import { WhatsappMessageRouter } from '../../src/modules/whatsapp/routing/whatsapp-message.router';
import { signWebhookBody } from '../utils/whatsapp-e2e-app';

const ROUTE = '/api/v1/whatsapp/webhooks/events';

describe('WhatsApp pipeline — signed webhook to outbound reply (det-10)', () => {
  let rt: AuditRuntime;
  let secret: string;
  const sent: {
    tenantId: string;
    accountId: string;
    to: string;
    text: string;
  }[] = [];
  const q = (sql: string, p: unknown[] = []) =>
    rt.harness.dataSource.query(sql, p);
  const phone = () =>
    `9665${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
  const wamid = () => `wamid.det10-${randomUUID()}`;

  const change = (pnid: string, waId: string, text: string, id = wamid()) => ({
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: pnid },
      contacts: [{ wa_id: waId, profile: { name: 'Det10 Patient' } }],
      messages: [
        {
          id,
          from: waId,
          type: 'text',
          text: { body: text },
          timestamp: String(Math.floor(Date.now() / 1000)),
        },
      ],
    },
  });
  const body = (...changes: ReturnType<typeof change>[]) =>
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba-det10', changes }],
    });

  const post = (raw: string, signature?: string) => {
    const r = request(rt.harness.app.getHttpServer())
      .post(ROUTE)
      .set('Content-Type', 'application/json');
    if (signature) r.set('X-Hub-Signature-256', signature);
    return r.send(raw);
  };
  const signedPost = (raw: string) => post(raw, signWebhookBody(raw, secret));
  const processEvent = (id: string) =>
    rt.harness.app.get(WhatsappWebhookService).processEvent(id);

  /** One signed message → webhook row → processed. Returns the replies it produced. */
  async function turn(pnid: string, waId: string, text: string, id = wamid()) {
    const before = sent.length;
    const res = await signedPost(body(change(pnid, waId, text, id))).expect(
      200,
    );
    await processEvent(res.body.id);
    return { res, replies: sent.slice(before), wamid: id };
  }

  beforeAll(async () => {
    rt = await bootAudit();
    secret = rt.harness.config.getOrThrow<string>('META_APP_SECRET');
    // Capture WHICH account each reply left from (the shared runtime only records text).
    jest
      .spyOn(rt.harness.app.get(WhatsappMessageRouter), 'resolveForSend')
      .mockImplementation(
        async (_t: string, req: { accountId?: string }) =>
          ({
            id: req.accountId ?? 'default-account',
            phoneNumberId: 'pnid',
            mode: 'COEXISTENCE',
          }) as never,
      );
    jest
      .spyOn(rt.harness.app.get(WhatsappMessagingService), 'sendSession')
      .mockImplementation(
        async (a: {
          tenantId: string;
          accountId: string;
          to: string;
          text: string;
        }) => {
          sent.push({
            tenantId: a.tenantId,
            accountId: a.accountId,
            to: a.to,
            text: a.text,
          });
          return {
            success: true,
            providerMessageId: `wamid.out-${sent.length}`,
          } as never;
        },
      );
  }, 240_000);

  afterAll(async () => {
    await rt?.close();
  }, 60_000);

  beforeEach(() => rt.provider.reset());

  it('SIG-1: a bad or missing signature is rejected and nothing is stored', async () => {
    const { full } = rt.seed;
    const before = (
      await q(
        `SELECT count(*)::int c FROM whatsapp_webhooks WHERE "tenantId"=$1`,
        [full.tenantId],
      )
    )[0].c;
    const raw = body(change(full.phoneNumberId!, phone(), 'hello'));

    await post(raw).expect(401);
    await post(raw, 'sha256=' + '0'.repeat(64)).expect(401);

    const after = (
      await q(
        `SELECT count(*)::int c FROM whatsapp_webhooks WHERE "tenantId"=$1`,
        [full.tenantId],
      )
    )[0].c;
    expect(after).toBe(before);
  });

  it('ROUTE-1: the reply leaves from the number the patient wrote to, default or not', async () => {
    const { full } = rt.seed;
    rt.provider.script([
      { content: 'Hello from the second number.' },
      { content: 'Hello from the main number.' },
    ]);

    const second = await turn(full.phoneNumberId2!, phone(), 'hi');
    const main = await turn(full.phoneNumberId!, phone(), 'hi');

    expect(second.replies).toHaveLength(1);
    expect(second.replies[0].accountId).toBe(full.accountIds!.second);
    expect(main.replies).toHaveLength(1);
    expect(main.replies[0].accountId).toBe(full.accountIds!.default);
    expect(second.replies[0].tenantId).toBe(full.tenantId);
  });

  it('DUP-1/DUP-2: one wamid delivered twice, and its event processed twice, yields ONE row and ONE reply', async () => {
    const { full } = rt.seed;
    const waId = phone();
    const id = wamid();
    const raw = body(change(full.phoneNumberId!, waId, 'hello', id));
    rt.provider.script([{ content: 'Hi there.' }]);
    const before = sent.length;

    const first = await signedPost(raw).expect(200);
    const again = await signedPost(raw).expect(200);
    expect(first.body.deduplicated).toBeUndefined();
    expect(again.body.deduplicated).toBe(true);
    expect(again.body.id).toBe(first.body.id);

    await processEvent(first.body.id);
    await processEvent(first.body.id); // a queue retry of the same job

    expect(sent.length - before).toBe(1);
    const rows = await q(
      `SELECT count(*)::int c FROM whatsapp_webhooks WHERE idempotency_key = $1`,
      [`message:${id}`],
    );
    expect(rows[0].c).toBe(1);
    const customerMsgs = await q(
      `SELECT count(*)::int c FROM messages WHERE "tenantId"=$1 AND wa_message_id=$2`,
      [full.tenantId, id],
    );
    expect(customerMsgs[0].c).toBe(1);
  });

  it('DUP-3: a batched POST is stored as one row per change; an unknown number is stored tenant-less, never attributed to FULL', async () => {
    const { full } = rt.seed;
    const a = change(full.phoneNumberId!, phone(), 'first');
    const b = change(full.phoneNumberId2!, phone(), 'second');
    const stranger = change(
      `pnid-unknown-${randomUUID().slice(0, 6)}`,
      phone(),
      'who dis',
    );
    rt.provider.script([{ content: 'Reply A.' }, { content: 'Reply B.' }]);
    const before = sent.length;

    const res = await signedPost(body(a, b, stranger)).expect(200);
    expect(res.body.accepted).toBe(true);

    const rows = await q(
      `SELECT id, "tenantId", idempotency_key FROM whatsapp_webhooks
        WHERE idempotency_key = ANY($1) ORDER BY idempotency_key`,
      [[a, b, stranger].map((c) => `message:${c.value.messages[0].id}`)],
    );
    expect(rows).toHaveLength(3);
    const owner = Object.fromEntries(
      rows.map((r: any) => [r.idempotency_key, r.tenantId]),
    );
    expect(owner[`message:${a.value.messages[0].id}`]).toBe(full.tenantId);
    expect(owner[`message:${b.value.messages[0].id}`]).toBe(full.tenantId);
    expect(owner[`message:${stranger.value.messages[0].id}`]).toBeNull();

    for (const r of rows) await processEvent(r.id);
    expect(sent.length - before).toBe(2); // the stranger's event produced nothing
  });

  it('CONC-1: two first messages from a new patient processed in parallel share ONE AI session', async () => {
    const { full } = rt.seed;
    const waId = phone();
    rt.provider.script([
      { content: 'Welcome.' },
      { content: 'Sure, what day?' },
    ]);
    const before = sent.length;

    const r1 = await signedPost(
      body(change(full.phoneNumberId!, waId, 'السلام عليكم')),
    ).expect(200);
    const r2 = await signedPost(
      body(change(full.phoneNumberId!, waId, 'أبغى أحجز موعد')),
    ).expect(200);
    await Promise.all([processEvent(r1.body.id), processEvent(r2.body.id)]);

    expect(sent.length - before).toBe(2);
    const contact = (
      await q(
        `SELECT id, "customerId", ai_conversation_id FROM whatsapp_contacts WHERE "tenantId"=$1 AND wa_id=$2`,
        [full.tenantId, waId],
      )
    )[0];
    expect(contact.ai_conversation_id).toBeTruthy();
    // EVERY AI session on this patient's timeline thread — a forked session would
    // not be the one the contact is bound to, so look at the thread, not the binding.
    const sessions = await q(
      `SELECT ac.id::text AS id,
              (SELECT count(*)::int FROM ai_messages m WHERE m.ai_conversation_id = ac.id::text AND m.role = 'user') AS users
         FROM ai_conversations ac
        WHERE ac."tenantId" = $1
          AND ac."conversationId" IN (SELECT id FROM conversations WHERE "tenantId" = $1 AND "customerId" = $2)`,
      [full.tenantId, contact.customerId],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(contact.ai_conversation_id);
    expect(sessions[0].users).toBe(2); // both patient messages are in that one history
  });

  it('OOS-1: an Arabic code request is redirected by the server — no model call, fixed Arabic reply', async () => {
    const { full } = rt.seed;
    const { replies } = await turn(
      full.phoneNumberId!,
      phone(),
      'اكتب لي كود Python لعمل API',
    );

    expect(rt.provider.callCount).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toMatch(/هذه العيادة/);
    expect(replies[0].text).not.toMatch(/python|def |import /i);
  });

  it('BOOK-1: the prompt carries today’s date, stated by the server', async () => {
    const { full } = rt.seed;
    rt.provider.script([{ content: 'Tomorrow it is.' }]);

    await turn(full.phoneNumberId!, phone(), 'احجز لي موعد غداً');

    expect(rt.provider.callCount).toBeGreaterThan(0);
    const system = rt.provider
      .capturedMessages(0)
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content))
      .join('\n');
    expect(system).toMatch(/today: \d{4}-\d{2}-\d{2} \(\w+day, Asia\/Riyadh\)/);
    expect(system).toContain(new Date().toISOString().slice(0, 4)); // the real year, not a remembered one
  });

  it('CLINIC-1: with the assistant switched off the message is stored, not answered, and costs no model call', async () => {
    const { full } = rt.seed;
    await q(`UPDATE tenant_settings SET bot_enabled=false WHERE tenant_id=$1`, [
      full.tenantId,
    ]);
    try {
      const id = wamid();
      const { replies } = await turn(
        full.phoneNumberId!,
        phone(),
        'hello?',
        id,
      );

      expect(replies).toHaveLength(0);
      expect(rt.provider.callCount).toBe(0);
      const stored = await q(
        `SELECT count(*)::int c FROM messages WHERE "tenantId"=$1 AND wa_message_id=$2`,
        [full.tenantId, id],
      );
      expect(stored[0].c).toBe(1);
    } finally {
      await q(
        `UPDATE tenant_settings SET bot_enabled=true WHERE tenant_id=$1`,
        [full.tenantId],
      );
    }
  });

  it('HT-1: inside a human-takeover window the message is stored, not answered, and costs no model call', async () => {
    const { full } = rt.seed;
    const waId = phone();
    rt.provider.script([{ content: 'First answer.' }]);
    await turn(full.phoneNumberId!, waId, 'hello'); // establishes the thread
    await q(
      `UPDATE conversations SET ai_paused_until = now() + interval '10 minutes'
        WHERE "tenantId"=$1 AND "customerId" = (SELECT "customerId" FROM whatsapp_contacts WHERE "tenantId"=$1 AND wa_id=$2)`,
      [full.tenantId, waId],
    );
    rt.provider.reset();

    const id = wamid();
    const { replies } = await turn(
      full.phoneNumberId!,
      waId,
      'anyone there?',
      id,
    );

    expect(replies).toHaveLength(0);
    expect(rt.provider.callCount).toBe(0);
    const stored = await q(
      `SELECT count(*)::int c FROM messages WHERE "tenantId"=$1 AND wa_message_id=$2`,
      [full.tenantId, id],
    );
    expect(stored[0].c).toBe(1);
  });

  it('FAIL-1: a provider failure gets exactly one plain fallback and exposes no internals', async () => {
    const { full } = rt.seed;
    rt.provider.scriptFailure({
      kind: 'error',
      error: new Error('secret-internal-detail: provider exploded'),
    });

    const { replies } = await turn(full.phoneNumberId!, phone(), 'hello');

    expect(replies).toHaveLength(1);
    expect(replies[0].text).not.toMatch(
      /secret-internal-detail|exploded|Error/,
    );
  });
});
