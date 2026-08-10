/**
 * FU-001 regression — `GET /api/v1/ai/handovers` (and every other
 * `HandoverRequestService` read) must not 500.
 *
 * WHY THIS SUITE EXISTS: `HandoverRequest.transferred_from` (`entities/AI
 * Agent/HandoverRequest.ts`) previously carried no `@JoinColumn`, so
 * TypeORM's default naming strategy derived the join column as
 * `transferredFromId` while the actual column — created explicitly by
 * `1730002800000-LiveAgentHandover.ts` — is snake_case `transferred_from_id`.
 * Every `find`/`findOne` requesting the `transferred_from` relation (all of
 * them, per `HandoverRequestService`) therefore failed unconditionally with
 * `QueryFailedError: column HandoverRequest.transferredFromId does not
 * exist`, confirmed live during the performance audit (`followup-register.md`
 * FU-001) and reproduced here against the real schema — a mocked-repository
 * unit test cannot catch this class of bug, only a real Postgres can.
 */
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { createE2eApp, createOwnerFixture, authHeader, cleanupTenant, type E2eApp } from './utils/whatsapp-e2e-app';
import { HandoverRequest } from '../src/entities/AI Agent/HandoverRequest';
import { Conversation } from '../src/entities/Conversations/Conversation';
import { Tenant } from '../src/entities/SaaS-Core/Tenant';
import { User } from '../src/entities/Auth&RBAC/User';

const SUITE = `fu001-${randomUUID().slice(0, 8)}`;

describe('FU-001 — HandoverRequest.transferred_from relation (real Postgres)', () => {
  let e2e: E2eApp;
  let tenantId: string;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    e2e = await createE2eApp();
    const owner = await createOwnerFixture(e2e, SUITE);
    tenantId = owner.tenantId;
    token = owner.token;
    userId = owner.userId;
  });

  afterAll(async () => {
    // handover_requests FKs to conversations, which cleanupTenant deletes —
    // must go first or the conversations DELETE 409s on the dangling FK.
    await e2e.dataSource.query(`DELETE FROM handover_requests WHERE "tenantId" = $1`, [tenantId]);
    await cleanupTenant(e2e, tenantId);
    await e2e.app.close();
  });

  it('GET /api/v1/ai/handovers does not 500 on a tenant with zero handover requests', async () => {
    const res = await request(e2e.app.getHttpServer())
      .get('/api/v1/ai/handovers')
      .set(...authHeader(token));

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
  });

  it('resolves a real transferred_from relation to the correct user, not a QueryFailedError', async () => {
    const conversations = e2e.dataSource.getRepository(Conversation);
    const handovers = e2e.dataSource.getRepository(HandoverRequest);

    const conversation = await conversations.save(
      conversations.create({ tenant: { id: tenantId } as Tenant, status: 'HANDED_OVER', owner_type: 'HUMAN' }),
    );
    const saved = await handovers.save(
      handovers.create({
        tenant: { id: tenantId } as Tenant,
        conversation: { id: conversation.id } as Conversation,
        status: 'ASSIGNED',
        transferred_from: { id: userId } as User,
      }),
    );

    const listRes = await request(e2e.app.getHttpServer())
      .get('/api/v1/ai/handovers')
      .set(...authHeader(token));
    expect(listRes.status).toBe(200);
    const items = Array.isArray(listRes.body) ? listRes.body : listRes.body.data;
    const found = items.find((h: { id: string }) => h.id === saved.id);
    expect(found).toBeDefined();

    const oneRes = await request(e2e.app.getHttpServer())
      .get(`/api/v1/ai/handovers/${saved.id}`)
      .set(...authHeader(token));
    expect(oneRes.status).toBe(200);
    expect(oneRes.body.transferred_from?.id).toBe(userId);
  });
});
