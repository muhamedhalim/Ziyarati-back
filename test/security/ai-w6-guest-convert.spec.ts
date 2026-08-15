/**
 * T084 — guest → patient convert abuse (FR-023, FR-111; research §R5).
 *
 * Two scenarios against the REAL `POST /public/guest/convert` route (full
 * HTTP stack — `JwtAuthGuard` → `GuestChatController.convert` →
 * `GuestSessionService.convert`, per `w2-guest-convert.md`'s trace, not just
 * the service method in isolation):
 *
 *  1. **Abuse**: guest A's holder (someone who legitimately possesses guest
 *     A's OWN `guest_token`) submits guest B's conversation id in the request
 *     body, attempting to have guest B's conversation converted into their
 *     own (the caller's) authenticated tenant. Refused, because
 *     `GuestSessionService.convert`'s step (6) compares the PRESENTED token's
 *     `sub` (guest A) against the TARGET conversation's bound `guestSubject`
 *     (guest B) — they never match regardless of which tenant the caller is
 *     authenticated into. This path never reaches step (7)/(8) below, so it
 *     is unaffected by the bug this file also documents.
 *  2. **Legitimate**: guest A converts guest A's own conversation into the
 *     caller's own tenant. This spec records EXACTLY which rows crossed into
 *     the target tenant.
 *
 * GENUINE GAP FOUND — SECOND, INDEPENDENT INSTANCE of the same defect class
 * `ai-w6-memory-summarization.spec.ts` (T081) found in `ai-memory.service.ts`
 * (reported, not hidden). `GuestSessionService.convert`'s step (7) — the
 * atomic conversion-claim update — is:
 *
 * ```ts
 * // guest-session.service.ts:188-196
 * const claimed = await this.conversations
 *   .createQueryBuilder()
 *   .update(AiConversation)
 *   .set({ status: AI_CONVERSATION_STATUS.CONVERTED })
 *   .where('id = :id', { id: guestConversationId })
 *   .andWhere('tenant_id = :tenantId', { tenantId: discoveryTenantId })
 *   .andWhere('status = :active', { active: AI_CONVERSATION_STATUS.ACTIVE })
 *   .execute();
 * ```
 *
 * `.andWhere('tenant_id = :tenantId', ...)` references a column that does not
 * exist on `ai_conversations` — the real column is `"tenantId"` (confirmed
 * live below and independently against `information_schema.columns`, exactly
 * as T081 confirmed for `ai_messages`). This UPDATE throws
 * `column "tenant_id" does not exist` on EVERY call — BEFORE the atomic claim
 * ever takes effect, and BEFORE step (8) (`summarizeConversation`, T081's
 * finding) is ever reached. The practical consequence, confirmed end-to-end
 * through the real route below, is worse than T081's finding in isolation
 * suggested: the conversion is never claimed at all (status stays `ACTIVE`,
 * not `CONVERTED`), so — unlike what a partial-claim theory would predict —
 * the conversation remains retriable, but `POST /public/guest/convert`
 * currently returns a `500` for every call, legitimate or not, and zero rows
 * ever cross into the target tenant. The entire guest→patient conversion
 * feature (FND-001, the controller's own `@ApiOperation` description) is
 * presently non-functional, not merely missing its memory-summary step.
 */
import request from 'supertest';
import type { Socket } from 'socket.io';

import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { WsAuthService } from '../../src/modules/ai-realtime/ws-auth.service';
import { AI_MESSAGE_ROLE } from '../../src/modules/ai/ai.constants';

const CONVERT_ROUTE = '/api/v1/public/guest/convert';
const SESSION_ROUTE = '/api/v1/public/guest/session';

describe('AI guest → patient convert abuse (T084)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let sessions: ConversationSessionService;
  let accessSecret: string;

  /** Mints a real guest session, returning both the raw cookie value (needed
   *  to call `/convert` as this exact holder) and the verified sub. */
  async function mintGuestRaw(): Promise<{ guestTokenCookie: string; sub: string }> {
    const res = await request(harness.app.getHttpServer()).post(SESSION_ROUTE).send({}).expect(200);
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const raw = cookies.find((c) => c.startsWith('guest_token='));
    if (!raw) throw new Error('guest_token cookie was not issued');
    const cookieValue = raw.split(';')[0];
    const wsAuth = harness.app.get(WsAuthService);
    const principal = await wsAuth.authenticate({
      handshake: { auth: {}, headers: { cookie: cookieValue }, query: {} },
    } as unknown as Socket);
    return { guestTokenCookie: cookieValue, sub: principal.id };
  }

  async function accessTokenFor(userId: string, tenantId: string): Promise<string> {
    return harness.jwt.signAsync({ sub: userId, tenantId, type: 'access' }, { secret: accessSecret, expiresIn: '15m' });
  }

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    sessions = harness.app.get(ConversationSessionService);
    accessSecret = harness.config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }, 120_000);

  afterAll(async () => {
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  it('[GENUINE GAP, confirmed independently] the atomic claim UPDATE in guest-session.service.ts:188-196 also references the non-existent "tenant_id" column on ai_conversations', async () => {
    const cols: { column_name: string }[] = await harness.dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_conversations'`,
    );
    expect(cols.map((c) => c.column_name)).toContain('tenantId');
    expect(cols.map((c) => c.column_name)).not.toContain('tenant_id');

    await expect(
      harness.dataSource.query(
        `UPDATE ai_conversations SET status = $1 WHERE id = $2 AND tenant_id = $3 AND status = $4`,
        ['CONVERTED', '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'ACTIVE'],
      ),
    ).rejects.toThrow(/column "tenant_id" does not exist/i);
  });

  it('[abuse] guest A holds a valid guest_token but names guest B\'s conversation — refused, guest B\'s conversation is NOT converted, and no row lands in the target tenant', async () => {
    const guestA = await mintGuestRaw();
    const guestB = await mintGuestRaw();
    expect(guestA.sub).not.toBe(guestB.sub);

    const convB = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, convB.id, { guestSubject: guestB.sub });

    const accessToken = await accessTokenFor(seed.tenantA.staffUserId, seed.tenantA.id);
    const before = await harness.dataSource.query(`SELECT status FROM ai_conversations WHERE id = $1`, [convB.id]);
    expect(before[0].status).toBe('ACTIVE');

    const res = await request(harness.app.getHttpServer())
      .post(CONVERT_ROUTE)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', guestA.guestTokenCookie) // attacker presents THEIR OWN guest token
      .send({ guestConversationId: convB.id }); // but names guest B's conversation

    // The ownership check (step 6) refuses BEFORE step (7)'s buggy UPDATE is
    // ever reached — so this scenario's outcome is a clean 404, distinct from
    // the 500 the legitimate-path tests below observe. Proves the abuse
    // refusal and the unrelated bug are two separate code paths, not the same
    // failure being mistaken for a security control.
    expect(res.status).toBe(404);

    // Guest B's conversation is untouched — the abuse attempt had zero effect.
    const after = await harness.dataSource.query(`SELECT status FROM ai_conversations WHERE id = $1`, [convB.id]);
    expect(after[0].status).toBe('ACTIVE');

    // No memory row crossed into tenant A (the attacker's own tenant) sourced
    // from guest B's conversation.
    const leaked = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1 AND ai_conversation_id = $2`,
      [seed.tenantA.id, convB.id],
    );
    expect(leaked[0].c).toBe(0);

    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convB.id]);
  });

  it('AI-002 — [legitimate, own conversation — GENUINE GAP observed end-to-end] converting guest A\'s OWN conversation currently fails on every call: 500, conversation stays ACTIVE (never claimed), zero rows cross into the target tenant', async () => {
    const guestA = await mintGuestRaw();
    const convA = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, convA.id, { guestSubject: guestA.sub });
    // A real prior user turn to summarize, mirroring T081's setup — proves
    // the failure below is not merely "there was nothing to summarize".
    await harness.dataSource.query(
      `INSERT INTO ai_messages (ai_conversation_id, "tenantId", role, content) VALUES ($1, $2, $3, $4)`,
      [convA.id, seed.discoveryTenantId, AI_MESSAGE_ROLE.USER, 'I would like to book a follow-up appointment please.'],
    );

    const accessToken = await accessTokenFor(seed.tenantA.staffUserId, seed.tenantA.id);

    const memoriesBefore = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );

    const res = await request(harness.app.getHttpServer())
      .post(CONVERT_ROUTE)
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Cookie', guestA.guestTokenCookie)
      .send({ guestConversationId: convA.id });

    // Observed live (2026-08-15): 500, code DATABASE_ERROR, underlying cause
    // `QueryFailedError: column "tenant_id" does not exist` — the SAME error
    // shape the direct-SQL reproduction above throws, confirming this HTTP
    // call hits the exact same bug, not a different failure.
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ code: 'DATABASE_ERROR' });

    // Row inventory AFTER the call — this is the "exactly which rows crossed"
    // proof the task asks for.
    const convRow = await harness.dataSource.query(`SELECT status FROM ai_conversations WHERE id = $1`, [convA.id]);
    const memoriesAfter = await harness.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM ai_memories WHERE "tenantId" = $1`,
      [seed.tenantA.id],
    );
    const newMemoryRows = memoriesAfter[0].c - memoriesBefore[0].c;

    // The claim UPDATE itself throws (this file's first test), so it never
    // commits — the conversation is left ACTIVE, not CONVERTED. Zero memory
    // rows cross into the target tenant either way. Net effect: the
    // documented "carries the guest thread forward... by summarising it into
    // the patient tenant's long-term memory" behavior never happens, for any
    // caller, ever, in the current codebase state — but at least the
    // conversation is NOT left in an unrecoverable half-claimed state (a
    // silver lining this test records precisely rather than assuming).
    expect(convRow[0].status).toBe('ACTIVE');
    expect(newMemoryRows).toBe(0);

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convA.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA.id]);
  });

  it('[control] a repeated attempt on the same conversation behaves identically each time (no partial state accumulates from the failed attempts)', async () => {
    const guestA = await mintGuestRaw();
    const convA = await conversations.start(seed.discoveryTenantId, {});
    await sessions.patch(seed.discoveryTenantId, convA.id, { guestSubject: guestA.sub });
    const accessToken = await accessTokenFor(seed.tenantA.staffUserId, seed.tenantA.id);

    const attempt = () =>
      request(harness.app.getHttpServer())
        .post(CONVERT_ROUTE)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', guestA.guestTokenCookie)
        .send({ guestConversationId: convA.id });

    const res1 = await attempt();
    const res2 = await attempt();

    expect(res1.status).toBe(500);
    expect(res2.status).toBe(500); // still ACTIVE after attempt 1, so attempt 2 hits the identical bug again, not a "not found"

    const convRow = await harness.dataSource.query(`SELECT status FROM ai_conversations WHERE id = $1`, [convA.id]);
    expect(convRow[0].status).toBe('ACTIVE');

    await harness.dataSource.query(`DELETE FROM ai_messages WHERE ai_conversation_id = $1`, [convA.id]);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [convA.id]);
  });
});
