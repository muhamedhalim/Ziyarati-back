/**
 * HTTP e2e — Meta Tech Provider WhatsApp/Campaign integration, Meta env SET.
 *
 * Boots the real app against the real dev Postgres + Redis; MetaGraphClient
 * and MetaWhatsappProvider are jest mocks (no real Meta network calls). See
 * test/utils/whatsapp-e2e-app.ts for the bootstrap/fixture/cleanup helpers.
 *
 * Scenario numbering matches the brief's 18-item list. #1/#2 (unconfigured
 * platform) live in whatsapp-onboarding-unconfigured.e2e-spec.ts, since they
 * need Meta env EMPTY — the opposite precondition from every scenario here.
 */
// MUST be the first import — sets Meta env vars before AppModule (imported
// transitively by whatsapp-e2e-app.ts below) triggers ConfigModule.forRoot(),
// which reads process.env synchronously and caches the result. See that
// file's docstring for the full explanation.
import { TEST_META_ENV } from './utils/whatsapp-meta-env-configured.setup';

import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import {
  createE2eApp,
  createOwnerFixture,
  cleanupTenant,
  authHeader,
  signWebhookBody,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';

import { WhatsappWebhookService } from '../src/modules/whatsapp/whatsapp-webhook.service';
import { WhatsappMediaService } from '../src/modules/whatsapp/meta/whatsapp-media.service';
import { StorageService } from '../src/modules/storage/storage.service';

import { Conversation } from '../src/entities/Conversations/Conversation';
import { Message } from '../src/entities/Conversations/Message';
import { MessageAttachment } from '../src/entities/Conversations/MessageAttachment';
import { Customer } from '../src/entities/CRM/Customer';
import { Campaign } from '../src/entities/Campaigns/Campaign';
import { CampaignRun } from '../src/entities/Campaigns/CampaignRun';
import { CampaignRecipient } from '../src/entities/Campaigns/CampaignRecipient';
import { WhatsappAccount } from '../src/entities/WhatsApp/WhatsappAccount';
import { ScheduledNotification } from '../src/entities/Notifications/ScheduledNotification';
import {
  CampaignExecution,
  RecipientDelivery,
  RecipientProcessing,
} from '../src/entities/enums';

const API = '/api/v1';

// `CreateWhatsappTemplateDto` requires `category` and a non-empty
// `components` array (Meta itself requires both on every real template) —
// no placeholders, so no `example` is needed either. Shared by every
// `POST /whatsapp/templates` call below to keep the minimal valid payload
// in one place.
const MINIMAL_TEMPLATE_BODY = {
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'This is a test template message.' }],
};

describe('WhatsApp Tech Provider (Meta configured) — HTTP e2e', () => {
  let e2e: E2eApp;
  let ds: DataSource;
  let tenantA: OwnerFixture;
  let tenantB: OwnerFixture;

  beforeAll(async () => {
    e2e = await createE2eApp();
    ds = e2e.dataSource;
    tenantA = await createOwnerFixture(e2e, 'a');
    tenantB = await createOwnerFixture(e2e, 'b');
  }, 60_000);

  afterAll(async () => {
    await cleanupTenant(e2e, tenantA.tenantId);
    await cleanupTenant(e2e, tenantB.tenantId);
    await e2e.app.close();
  }, 30_000);

  // ── #4 authenticated tenant can complete mocked onboarding ──────────────
  it('#4 completes Embedded Signup for the authenticated tenant', async () => {
    const wabaId = `waba-${tenantA.tenantId}`;
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-1', wabaId })
      .expect(200);

    expect(res.body).toMatchObject({
      wabaId,
      phoneNumberId: `phone-${wabaId}`,
      connectionStatus: 'CONNECTED',
      isDefault: true,
    });
    expect(e2e.metaGraph.exchangeCode).toHaveBeenCalledWith('auth-code-1');
    expect(e2e.metaGraph.subscribeAppToWaba).toHaveBeenCalled();
  });

  // ── #5 frontend-supplied WABA/phone ids are not trusted ─────────────────
  it('#5 rejects a phoneNumberId that does not belong to the WABA Meta reports', async () => {
    const wabaId = `waba-untrusted-${tenantA.tenantId}`;
    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-x', wabaId, phoneNumberId: 'attacker-supplied-id' })
      .expect(422);

    expect(res.body.message).toMatch(/does not belong/i);
  });

  // ── #6 access tokens are never returned ──────────────────────────────────
  it('#6 never returns an access token from onboarding or account reads', async () => {
    const body = JSON.stringify(await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenantA.token))
      .expect(200)
      .then((r) => r.body));
    expect(body).not.toContain('mock-long-lived-token');
    expect(body).not.toMatch(/access_?[Tt]oken/);
  });

  // ── #7 another tenant cannot access the connected account ───────────────
  it('#7 a foreign tenant cannot read another tenant\'s WhatsApp account', async () => {
    const list = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenantA.token))
      .expect(200);
    const accountId = list.body.data[0].id;

    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts/${accountId}/connection-status`)
      .set(...authHeader(tenantB.token))
      .expect(404);
  });

  // ── #10 default account selection works ──────────────────────────────────
  it('#10 the first connected number becomes default; a second connect does not steal it; setDefault does', async () => {
    const wabaId2 = `waba-second-${tenantA.tenantId}`;
    const second = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-2', wabaId: wabaId2 })
      .expect(200);
    expect(second.body.isDefault).toBe(false); // tenant already has a default from #4

    await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/accounts/${second.body.id}/default`)
      .set(...authHeader(tenantA.token))
      .expect(200);

    const list = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenantA.token))
      .expect(200);
    const defaults = list.body.data.filter((a: { is_default: boolean }) => a.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(second.body.id);
  });

  // ── #8 / #9 disconnect blocks sending, reconnect restores it ─────────────
  describe('#8/#9 disconnect blocks sending; reconnect restores it', () => {
    let accountId: string;
    let templateId: string;
    let wabaId: string;

    beforeAll(async () => {
      wabaId = `waba-disc-${tenantA.tenantId}`;
      const connected = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantA.token))
        .send({ code: 'auth-code-disc', wabaId })
        .expect(200);
      accountId = connected.body.id;

      const tpl = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/templates`)
        .set(...authHeader(tenantA.token))
        .send({
          name: `disc_test_${randomUUID().slice(0, 8)}`,
          language: 'en',
          accountId,
          ...MINIMAL_TEMPLATE_BODY,
        })
        .expect(201);
      templateId = tpl.body.id;
      // GAP-002 (whatsapp-template.service.ts): `status` can never be set to
      // APPROVED through the client-facing create/update endpoints — only
      // WhatsappTemplateSyncService (mirroring Meta's real review verdict) may
      // write it, directly on the repository. Same bypass this file already
      // uses below for `waba_id` (also never client-settable) to arrange a
      // precondition the API deliberately cannot produce.
      await ds.getRepository('whatsapp_templates').update(templateId, { status: 'approved' });
    });

    it('#8 sending fails once the account is disconnected', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/accounts/${accountId}/disconnect`)
        .set(...authHeader(tenantA.token))
        .expect(200);

      // A disconnected account fails account RESOLUTION (WhatsappAccountResolver
      // rejects non-CONNECTED before the provider is ever reached) — a 422 on
      // the request itself, not a 201 with a FAILED provider outcome. Those are
      // different failure shapes: this one never gets far enough to attempt IO.
      const send = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/templates/${templateId}/send`)
        .set(...authHeader(tenantA.token))
        .send({ accountId, toWaId: '15550001111' })
        .expect(422);

      expect(send.body.message).toMatch(/disconnect|not connected|reauthorize/i);
      expect(e2e.whatsappProvider.send).not.toHaveBeenCalled();
    });

    it('#9 re-running Embedded Signup for the same number restores sending', async () => {
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantA.token))
        .send({ code: 'auth-code-reconnect', wabaId })
        .expect(200);

      const send = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/templates/${templateId}/send`)
        .set(...authHeader(tenantA.token))
        .send({ accountId, toWaId: '15550001111' })
        .expect(201);

      expect(send.body.status).toBe('SENT');
      expect(e2e.whatsappProvider.send).toHaveBeenCalled();
    });
  });

  // ── #19 remove connection (soft-delete): history survives, number frees up ──
  describe('#19 remove connection preserves history and frees the number for reconnection', () => {
    let accountId: string;
    let templateId: string;
    let wabaId: string;
    let phoneNumberId: string;

    beforeAll(async () => {
      wabaId = `waba-remove-${tenantA.tenantId}`;
      const connected = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantA.token))
        .send({ code: 'auth-code-remove', wabaId })
        .expect(200);
      accountId = connected.body.id;
      phoneNumberId = connected.body.phoneNumberId;

      const tpl = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/templates`)
        .set(...authHeader(tenantA.token))
        .send({
          name: `remove_test_${randomUUID().slice(0, 8)}`,
          language: 'en',
          accountId,
          ...MINIMAL_TEMPLATE_BODY,
        })
        .expect(201);
      templateId = tpl.body.id;
    });

    it('a foreign tenant cannot remove another tenant\'s account (404, nothing changed)', async () => {
      await request(e2e.app.getHttpServer())
        .delete(`${API}/whatsapp/accounts/${accountId}`)
        .set(...authHeader(tenantB.token))
        .expect(404);

      // Still fully visible/usable by its real owner afterwards.
      await request(e2e.app.getHttpServer())
        .get(`${API}/whatsapp/accounts/${accountId}`)
        .set(...authHeader(tenantA.token))
        .expect(200);
    });

    it('the owning tenant can remove it (soft-delete, 204)', async () => {
      await request(e2e.app.getHttpServer())
        .delete(`${API}/whatsapp/accounts/${accountId}`)
        .set(...authHeader(tenantA.token))
        .expect(204);

      // Gone from the normal listing/read surface...
      await request(e2e.app.getHttpServer())
        .get(`${API}/whatsapp/accounts/${accountId}`)
        .set(...authHeader(tenantA.token))
        .expect(404);
    });

    it('the row itself still exists (soft-deleted, not hard-deleted) so FK-referencing history resolves', async () => {
      // The account row must still physically exist — a hard delete here
      // would violate the ON DELETE NO ACTION FK from whatsapp_templates and
      // conversations, and would destroy history those tables still point to.
      const raw = await ds.query(
        `SELECT id, deleted_at FROM whatsapp_accounts WHERE id = $1`,
        [accountId],
      );
      expect(raw).toHaveLength(1);
      expect(raw[0].deleted_at).not.toBeNull();

      // The template created against this account is untouched and still
      // resolves its whatsapp_account relation — nothing was cascaded away.
      const template = await request(e2e.app.getHttpServer())
        .get(`${API}/whatsapp/templates/${templateId}`)
        .set(...authHeader(tenantA.token))
        .expect(200);
      expect(template.body.id).toBe(templateId);
      expect(template.body.waba_id).toBe(wabaId);
    });

    it('the freed phone number can be reconnected by the same tenant through Embedded Signup', async () => {
      const reconnected = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantA.token))
        .send({ code: 'auth-code-remove-2', wabaId })
        .expect(200);

      // A NEW row (the removed one stays soft-deleted forever) reusing the
      // same phone number — proves the partial unique index (WHERE deleted_at
      // IS NULL) does its job.
      expect(reconnected.body.id).not.toBe(accountId);
      expect(reconnected.body.phoneNumberId).toBe(phoneNumberId);
      expect(reconnected.body.connectionStatus).toBe('CONNECTED');
    });
  });

  // ── #11 campaign account ownership is enforced ───────────────────────────
  it('#11 a campaign cannot reference another tenant\'s WhatsApp account', async () => {
    const accountsB = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenantB.token))
      .expect(200);
    if (accountsB.body.data.length === 0) {
      // Tenant B needs its own connected account to prove cross-tenant
      // rejection (not just "any UUID is invalid").
      await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantB.token))
        .send({ code: 'auth-code-b', wabaId: `waba-${tenantB.tenantId}` })
        .expect(200);
    }
    const accountsA = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/accounts`)
      .set(...authHeader(tenantA.token))
      .expect(200);
    const foreignAccountId = accountsA.body.data[0].id;

    const res = await request(e2e.app.getHttpServer())
      .post(`${API}/campaigns`)
      .set(...authHeader(tenantB.token))
      .send({ type: 'PROMOTION', name: 'Cross-tenant test', whatsappAccountId: foreignAccountId })
      .expect(422);
    expect(res.body.message).toMatch(/not found/i);
  });

  // ── #12 campaign template must belong to the same WABA ───────────────────
  it('#12 launch is rejected when the template lives on a different WABA than the sending number', async () => {
    const wabaId = `waba-launch-${tenantA.tenantId}`;
    const connected = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-launch', wabaId })
      .expect(200);
    const accountId = connected.body.id;

    const tpl = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/templates`)
      .set(...authHeader(tenantA.token))
      .send({
        name: `waba_mismatch_${randomUUID().slice(0, 8)}`,
        language: 'en',
        accountId,
        ...MINIMAL_TEMPLATE_BODY,
      })
      .expect(201);
    // Force a WABA mismatch: created via the API with the right account, then
    // its waba_id is overwritten directly — the API has no field for this
    // (waba_id only ever comes from Meta sync), so this is the only way to
    // arrange the precondition under test. `status` is bypassed the same way,
    // for the same reason (GAP-002 — see the #8/#9 block above): only
    // WhatsappTemplateSyncService may ever write APPROVED.
    await ds.getRepository('whatsapp_templates').update(tpl.body.id, { waba_id: 'a-different-waba', status: 'approved' });

    const campaign = await request(e2e.app.getHttpServer())
      .post(`${API}/campaigns`)
      .set(...authHeader(tenantA.token))
      .send({
        type: 'PROMOTION',
        name: `WABA mismatch ${randomUUID().slice(0, 8)}`,
        whatsappAccountId: accountId,
        templateId: tpl.body.id,
      })
      .expect(201);

    const launch = await request(e2e.app.getHttpServer())
      .post(`${API}/campaigns/${campaign.body.id}/launch`)
      .set(...authHeader(tenantA.token))
      .send({ force: true })
      .expect(422);
    expect(launch.body.message).toMatch(/waba|whatsapp business account/i);
  });

  // ── #13 / #14 webhook verification ───────────────────────────────────────
  it('#13 the GET verification handshake succeeds with the correct token', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/webhooks/verify`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'echo-123' })
      .expect(200);
    expect(res.text).toBe('echo-123');
  });

  it('#14 the GET handshake is rejected with the wrong token', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/webhooks/verify`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'echo-123' })
      .expect(403);
  });

  // Meta's webhook config takes ONE Callback URL and drives BOTH halves of the
  // protocol through it: the GET handshake when the URL is saved, then every
  // event POST. These two pin that the ingestion path answers both, because
  // that is the URL an operator actually registers — when the handshake lived
  // only on `/verify`, `GET /events` fell through to the authenticated
  // `@Get(':id')` and answered 401, so Meta refused to save the URL at all.
  it('#14c the GET handshake also succeeds on the ingestion path (single Meta callback URL)', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/webhooks/events`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'test-verify-token', 'hub.challenge': 'echo-456' })
      .expect(200);
    expect(res.text).toBe('echo-456');
  });

  it('#14d the handshake on the ingestion path still fails closed on a wrong token', async () => {
    await request(e2e.app.getHttpServer())
      .get(`${API}/whatsapp/webhooks/events`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'echo-456' })
      .expect(403);
  });

  it('#14b an inbound event with an invalid signature is rejected (401)', async () => {
    const payload = JSON.stringify({ entry: [] });
    await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/webhooks/events`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
      .send(payload)
      .expect(401);
  });

  // ── #15 / #16 webhook ingestion + dedupe ─────────────────────────────────
  describe('#15/#16 webhook ingestion, fast-200, and idempotency-key dedupe', () => {
    let connectedPhoneNumberId: string;

    beforeAll(async () => {
      const wabaId = `waba-webhook-${tenantA.tenantId}`;
      const connected = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/onboarding/complete`)
        .set(...authHeader(tenantA.token))
        .send({ code: 'auth-code-webhook', wabaId })
        .expect(200);
      connectedPhoneNumberId = connected.body.phoneNumberId;
    });

    it('#15 a valid signed event is accepted (200) and queued', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const payload = JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: connectedPhoneNumberId },
                  messages: [
                    {
                      id: wamid,
                      from: '15550009999',
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
      });
      const res = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
        .send(payload)
        .expect(200);

      expect(res.body.accepted).toBe(true);
      expect(res.body.id).toBeTruthy();

      const row = await ds.query(`SELECT * FROM whatsapp_webhooks WHERE id = $1`, [res.body.id]);
      expect(row).toHaveLength(1);
      expect(row[0].processed).toBe(false);
    });

    it('#16 the same wamid delivered twice is de-duplicated at ingestion (no second row)', async () => {
      const wamid = `wamid.${randomUUID()}`;
      const payload = JSON.stringify({
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: connectedPhoneNumberId },
                  messages: [
                    {
                      id: wamid,
                      from: '15550009999',
                      type: 'text',
                      text: { body: 'dup' },
                      timestamp: String(Math.floor(Date.now() / 1000)),
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const signature = signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET);

      const first = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(payload)
        .expect(200);
      expect(first.body.deduplicated).toBeFalsy();

      const second = await request(e2e.app.getHttpServer())
        .post(`${API}/whatsapp/webhooks/events`)
        .set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', signature)
        .send(payload)
        .expect(200);
      expect(second.body).toMatchObject({ accepted: true, id: first.body.id, deduplicated: true });

      const rows = await ds.query(
        `SELECT id FROM whatsapp_webhooks WHERE idempotency_key = $1`,
        [`message:${wamid}`],
      );
      expect(rows).toHaveLength(1);

      // NOTE: this proves ingestion-level dedupe (the actual mechanism that
      // stops a redelivered event from being processed twice). It does NOT
      // drive the event through to a Message row — that happens inside
      // WhatsappInboundAiService.handleInboundValue, which runs a full AI
      // orchestrator turn (RAG, tool-calling, an LLM call). Exercising that
      // honestly would mean mocking the entire AI stack, which is out of
      // scope for this webhook-focused suite.
    });
  });

  // ── #17 media processing creates attachments ─────────────────────────────
  it('#17 downloading inbound media creates a MessageAttachment with a stored file', async () => {
    const media = e2e.app.get(WhatsappMediaService);
    const storage = e2e.app.get(StorageService);
    const uploadSpy = jest.spyOn(storage, 'upload').mockResolvedValue({
      storageKey: `${tenantA.tenantId}/whatsapp-image/mock.jpg`,
      filename: 'mock.jpg',
      mimeType: 'image/jpeg',
      size: 17,
      sha256: 'mock-sha',
    });

    const conversations = ds.getRepository(Conversation);
    const messages = ds.getRepository(Message);
    const attachments = ds.getRepository(MessageAttachment);
    const accounts = ds.getRepository(WhatsappAccount);

    const account = await accounts.findOne({ where: { tenant: { id: tenantA.tenantId } }, order: { created_at: 'ASC' } });
    const conversation = await conversations.save(
      conversations.create({ tenant: { id: tenantA.tenantId } as never }),
    );
    const message = await messages.save(
      messages.create({
        tenant: { id: tenantA.tenantId } as never,
        conversation: { id: conversation.id } as never,
        sender_type: 'CUSTOMER',
        message_type: 'image',
        wa_message_id: `wamid.media.${randomUUID()}`,
      }),
    );

    const result = await media.downloadAndAttach({
      tenantId: tenantA.tenantId,
      accountId: account!.id,
      messageId: message.id,
      mediaId: `media-${randomUUID()}`,
      mediaType: 'image',
      mimeType: 'image/jpeg',
      filename: 'photo.jpg',
    });

    expect(result.attached).toBe(true);
    expect(uploadSpy).toHaveBeenCalled();

    const saved = await attachments.find({ where: { message: { id: message.id } } });
    expect(saved).toHaveLength(1);
    expect(saved[0].file_url).toBeTruthy();
    expect(saved[0].provider_media_id).toBeTruthy();

    uploadSpy.mockRestore();
    await attachments.delete({ id: saved[0].id });
    await messages.delete({ id: message.id });
    await conversations.delete({ id: conversation.id });
  });

  // ── #18 campaign statuses update from webhook events ─────────────────────
  it('#18 a delivered/read webhook status updates the campaign recipient + run counters (the previously-missing seam)', async () => {
    const wabaId = `waba-status-${tenantA.tenantId}`;
    const connected = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-status', wabaId })
      .expect(200);

    const customers = ds.getRepository(Customer);
    const campaigns = ds.getRepository(Campaign);
    const runs = ds.getRepository(CampaignRun);
    const recipients = ds.getRepository(CampaignRecipient);

    const customer = await customers.save(
      customers.create({
        tenant: { id: tenantA.tenantId } as never,
        full_name: 'Status Test Customer',
        phone: `1555${Math.floor(Math.random() * 9000000 + 1000000)}`,
        email: `status-${randomUUID()}@example.test`,
        marketing_opt_in: true,
        is_active: true,
      }),
    );
    const campaign = await campaigns.save(
      campaigns.create({
        tenant: { id: tenantA.tenantId } as never,
        type: 'PROMOTION' as never,
        name: `Status webhook test ${randomUUID().slice(0, 8)}`,
        lifecycle: 'ACTIVE' as never,
        throttle_per_minute: 30,
      }),
    );
    const run = await runs.save(
      runs.create({
        tenant: { id: tenantA.tenantId } as never,
        campaign: { id: campaign.id } as never,
        execution: CampaignExecution.PROCESSING,
        total_recipients: 1,
        sent: 1,
        idempotency_key: randomUUID(),
      }),
    );
    const wamid = `wamid.status.${randomUUID()}`;
    const recipient = await recipients.save(
      recipients.create({
        run: { id: run.id } as never,
        campaign: { id: campaign.id } as never,
        customer: { id: customer.id } as never,
        processing: RecipientProcessing.DISPATCHED,
        delivery: RecipientDelivery.ACCEPTED,
        provider_ref: wamid,
      }),
    );

    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: connected.body.phoneNumberId },
                statuses: [
                  { id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) },
                ],
              },
            },
          ],
        },
      ],
    });
    const ingest = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/webhooks/events`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
      .send(payload)
      .expect(200);

    // Drive the "worker" deterministically rather than racing the real queue
    // consumer — this IS the controlled-worker approach for this suite.
    const webhooks = e2e.app.get(WhatsappWebhookService);
    await webhooks.processEvent(ingest.body.id);

    const updatedRecipient = await recipients.findOne({ where: { id: recipient.id } });
    const updatedRun = await runs.findOne({ where: { id: run.id } });
    expect(updatedRecipient?.delivery).toBe(RecipientDelivery.DELIVERED);
    expect(updatedRun?.delivered).toBe(1);

    await recipients.delete({ id: recipient.id });
    await runs.delete({ id: run.id });
    await campaigns.delete({ id: campaign.id });
    await customers.delete({ id: customer.id });
  });

  // ── ZT-011 (009) — T042: no delivery-status functionality was lost ──────
  // The live handshake's sibling ingestion path (POST /whatsapp/webhooks/events)
  // must still forward Meta statuses to NotificationDeliveryService — the
  // FIRST of the three delivery axes whatsapp-webhook.service.ts:199 fans
  // out to (scheduled_notifications, via provider_ref), independent of the
  // campaign-recipient axis #18 above already covers.
  it('T042 a delivered webhook status updates NotificationDeliveryService (scheduled_notifications.delivery_status)', async () => {
    const wabaId = `waba-notif-status-${tenantA.tenantId}`;
    const connected = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/onboarding/complete`)
      .set(...authHeader(tenantA.token))
      .send({ code: 'auth-code-notif-status', wabaId })
      .expect(200);

    const scheduled = ds.getRepository(ScheduledNotification);
    const wamid = `wamid.notif.${randomUUID()}`;
    const row = await scheduled.save(
      scheduled.create({
        tenant: { id: tenantA.tenantId } as never,
        scheduled_at: new Date(),
        status: 'SENT',
        delivery_status: 'NONE',
        provider_ref: wamid,
      }),
    );

    const payload = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: connected.body.phoneNumberId },
                statuses: [
                  { id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) },
                ],
              },
            },
          ],
        },
      ],
    });
    const ingest = await request(e2e.app.getHttpServer())
      .post(`${API}/whatsapp/webhooks/events`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signWebhookBody(payload, TEST_META_ENV.META_APP_SECRET))
      .send(payload)
      .expect(200);

    const webhooks = e2e.app.get(WhatsappWebhookService);
    await webhooks.processEvent(ingest.body.id);

    const updated = await scheduled.findOne({ where: { id: row.id } });
    expect(updated?.delivery_status).toBe('DELIVERED');

    await scheduled.delete({ id: row.id });
  });
});
