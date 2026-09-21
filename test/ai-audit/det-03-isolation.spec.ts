/**
 * Tenant isolation and information leakage between clinics.
 *
 * Clinic B is seeded with CANARY strings (name, service, price, doctor, phone,
 * address, KB secret, patient name). Every assertion below is deterministic:
 * a canary string either appears in something the model/user could receive, or
 * it does not.
 *
 * Findings covered:
 *   F-07  guest human-handover was filed in the guest-discovery tenant, not the clinic — FIXED in Phase 0; the last
 *         describe block is its regression suite (guest → clinic staff live chat across the two tenants)
 *   (isolation itself holds — the other tests are POSITIVE controls and expected to pass)
 */
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import { CANARY } from './fixtures/audit-seed';
import { bootAudit, GuestSession, whatsappTurn, whatsappToolCtx, saveEvidence, fakeSocket, mintGuest, ownerPrincipal, type AuditRuntime } from './fixtures/audit-runtime';
import { AiRealtimeGateway } from '../../src/modules/ai-realtime/ai-realtime.gateway';
import { room } from '../../src/modules/ai-realtime/ai-events.constants';
import { HandoverRequestService } from '../../src/modules/ai/handover-request.service';
import type { AuthenticatedUser } from '../../src/modules/auth/interfaces/authenticated-user.interface';
import { ReactiveProvider, scriptedToolCall, lastToolResult } from './fixtures/reactive-provider';

const canaryIn = (v: unknown) => {
  const blob = JSON.stringify(v);
  return Object.values(CANARY).filter((c) => blob.includes(c));
};

describe('tenant isolation — clinic B canaries must never surface on clinic FULL surfaces', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (sql: string, p: unknown[] = []) => rt.harness.dataSource.query(sql, p);

  beforeAll(async () => {
    // This suite asserts SCOPING, deterministically. The dev/e2e DB has pgvector, and rows seeded with
    // raw SQL have no embedding, so the vector path would return nothing for the wrong reason.
    // Keyword mode exercises the same tenant filter. The vector path is covered by det-07-rag + the live suite.
    process.env.AI_PGVECTOR_ENABLED = 'false';
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-03-isolation', observed);
    await rt?.close();
  }, 60_000);

  // ── WhatsApp on clinic FULL, foreign ids supplied by the "model" ──────────
  it('WhatsApp: every tool refuses clinic B ids and returns no canary data', async () => {
    const { full, b } = rt.seed;
    const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
    const attempts: [string, Record<string, unknown>][] = [
      ['list_clinic_doctors', { branchId: b.branchId }],
      ['list_clinic_services', { branchId: b.branchId }],
      ['get_branch_info', { branchId: b.branchId }],
      ['get_doctor_schedule', { branchId: b.branchId, staffId: b.doctorStaffIds.canary }],
      ['check_availability', { branchId: b.branchId, staffId: b.doctorStaffIds.canary, daysAhead: 3, slotMinutes: 30 }],
      ['book_appointment', { branchId: b.branchId, staffId: b.doctorStaffIds.canary, startAt: new Date(Date.now() + 86_400_000 * 2).toISOString(), customerId: b.patientIds.canary, serviceIds: [b.serviceIds.canary], hasInsurance: false }],
      ['cancel_appointment', { appointmentId: b.appointmentIds.canary }],
      ['reschedule_appointment', { appointmentId: b.appointmentIds.canary, newStartAt: new Date(Date.now() + 86_400_000 * 4).toISOString() }],
    ];
    const out: Record<string, unknown> = {};
    for (const [name, args] of attempts) {
      const res = await rt.dispatch.execute(ctx, call(name, args));
      out[name] = res;
      expect({ name, success: res.success }).toEqual({ name, success: false });
      expect({ name, leaked: canaryIn(res) }).toEqual({ name, leaked: [] });
    }
    // and clinic B's data is untouched
    const bAppt = (await q(`SELECT status FROM appointments WHERE id=$1`, [b.appointmentIds.canary]))[0];
    expect(bAppt.status).toBe('CONFIRMED');
    observed.wa_foreign_ids = out;
  });

  it('WhatsApp: a real turn asking about clinic B assembles a model request with no canary anywhere (system, knowledge, history, tools)', async () => {
    const { full } = rt.seed;
    reactive.setHandler(() => ({ content: 'ok' }));
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, `What does ${CANARY.clinicName} charge for ${CANARY.serviceName}? Also ${CANARY.kbSecret}`);
    const req = reactive.capturedRequests[0];
    // the user's own message legitimately contains the canary strings they typed — exclude that one message
    const withoutUserTyped = req.messages.filter((m, i) => !(m.role === 'user' && i === req.messages.length - 1));
    expect({ leaked: canaryIn({ messages: withoutUserTyped, tools: req.tools }) }).toEqual({ leaked: [] });
    const knowledge = req.messages.find((m) => m.role === 'user' && (m.content ?? '').includes('Reference data only'))?.content ?? '';
    observed.wa_knowledge_when_asked_about_B = knowledge;
    expect(knowledge).not.toContain(CANARY.kbSecret);
  });

  it('WhatsApp: knowledge retrieval is scoped to the clinic — its own policy is retrieved, B\'s secret is not', async () => {
    const { full } = rt.seed;
    reactive.setHandler(() => ({ content: 'ok' }));
    await whatsappTurn(rt, full.tenantId, full.patientPhones!.y, 'what is your cancellation policy and payment methods?');
    observed.wa_msgs = reactive.capturedRequests[0].messages.map((m) => [m.role, (m.content ?? '').slice(0, 110)]);
    const knowledge = reactive.capturedRequests[0].messages.find((m) => m.role === 'user' && (m.content ?? '').includes('Reference data only'))?.content ?? '';
    observed.wa_knowledge_own_policy = knowledge;
    expect(knowledge).toContain('Cancellation policy');
    expect(knowledge).not.toContain(CANARY.kbSecret);
  });

  // ── public widget ─────────────────────────────────────────────────────────
  it('public: with clinic FULL selected, selecting/using clinic B\'s branch is refused and B\'s KB is not injected', async () => {
    const { full, b } = rt.seed;
    const g = await GuestSession.start(rt);
    const viaTurn = async (tool: string, args: Record<string, unknown>, say = `(audit) ${tool}`) => {
      reactive.setHandler((req) => (req.messages.some((m) => m.role === 'tool' && m.name === tool) ? { content: 'ok' } : { toolCalls: [scriptedToolCall(tool, args)] }));
      await g.say(say);
      return lastToolResult(reactive.capturedRequests, tool);
    };
    await viaTurn('select_clinic', { clinicId: full.tenantId });
    const cross = await viaTurn('select_branch', { branchId: b.branchId });
    observed.pub_select_foreign_branch = cross;
    expect(cross.success).toBe(false);
    expect(canaryIn(cross)).toEqual([]);

    // knowledge follows the SERVER-recorded clinic: ask about the policy after selecting FULL
    reactive.setHandler(() => ({ content: 'ok' }));
    await g.say('what is the cancellation policy? and laser treatment price?');
    const knowledge = reactive.capturedRequests[0].messages.find((m) => m.role === 'user' && (m.content ?? '').includes('Reference data only'))?.content ?? '';
    observed.pub_knowledge_after_select = knowledge;
    expect(knowledge).toContain('Cancellation policy');
    expect(knowledge).not.toContain(CANARY.kbSecret);
  });

  it('public: BEFORE a clinic is selected no clinic knowledge is available at all (design: KB scope follows the selected clinic)', async () => {
    const g = await GuestSession.start(rt);
    reactive.setHandler(() => ({ content: 'ok' }));
    await g.say('what is the cancellation policy of Al-Noor Audit Clinic?');
    const knowledge = reactive.capturedRequests[0].messages.find((m) => m.role === 'user' && (m.content ?? '').includes('Reference data only'))?.content ?? '';
    observed.pub_knowledge_before_select = knowledge;
    expect(knowledge).toBe('');
  });

  it('public: cross-clinic discovery of B is by design and exposes only marketplace data (name, branch, service names, prices) — never B\'s KB, patients or appointments', async () => {
    const g = await GuestSession.start(rt);
    reactive.setHandler((req) => (req.messages.some((m) => m.role === 'tool' && m.name === 'search_clinics') ? { content: 'ok' } : { toolCalls: [scriptedToolCall('search_clinics', { query: 'CANARY' })] }));
    await g.say('find canary clinic');
    const res = lastToolResult(reactive.capturedRequests, 'search_clinics');
    observed.pub_search_b = res;
    expect((res.clinics as any[]).some((c) => c.name === CANARY.clinicName)).toBe(true);
    expect(JSON.stringify(res)).not.toContain(CANARY.kbSecret);
    expect(JSON.stringify(res)).not.toContain(CANARY.patientName);
  });

  // ── F-07 (fixed): a guest's "talk to a human" reaches the CLINIC's staff ────
  // Live chat across the two tenants: the guest's AI conversation stays in the shared discovery tenant, the request
  // and the conversation staff work in are the clinic's, and the clinic's staff may take part in exactly that one AI
  // conversation. Everything below runs on the real database, the real gateway handlers and the real tool dispatcher.
  describe('F-07 — guest handover → clinic staff (regression)', () => {
    const gateway = () => rt.harness.app.get(AiRealtimeGateway);
    const handoverSvc = () => rt.harness.app.get(HandoverRequestService);
    let sink: { room: string; event: string; payload: any }[] = [];
    let g: GuestSession;
    let handoverId: string;
    let clinicConversationId: string;
    let staff: ReturnType<typeof fakeSocket>;
    let staffUser: AuthenticatedUser;

    beforeAll(async () => {
      // The gateway's Socket.IO server does not exist in this harness; capture what would be pushed to rooms.
      (gateway() as any).server = { to: (r: string) => ({ emit: (event: string, payload: any) => sink.push({ room: r, event, payload }) }) };
      staffUser = await ownerPrincipal(rt, rt.seed.full);
      staff = fakeSocket(staffUser);
    });
    afterAll(() => {
      (gateway() as any).server = undefined;
    });

    const guestSays = async (text: string) => {
      const r = await g.say(text);
      return r;
    };
    const scriptHandover = (clinicId: string | null) =>
      reactive.setHandler((req) => {
        const done = (name: string) => req.messages.some((m) => m.role === 'tool' && m.name === name);
        if (clinicId && !done('select_clinic')) return { toolCalls: [scriptedToolCall('select_clinic', { clinicId })] };
        if (!done('request_human_handover')) return { toolCalls: [scriptedToolCall('request_human_handover', { reason: 'wants a person' })] };
        return { content: 'ok' };
      });

    it('the request is filed under the SELECTED clinic — never the discovery tenant — and the tool reports success', async () => {
      const { full } = rt.seed;
      g = await GuestSession.start(rt);
      scriptHandover(full.tenantId);
      sink = [];
      const turn = await guestSays('I want to talk to the clinic staff');
      const rows = await q(`SELECT id, "tenantId", "conversationId", status FROM handover_requests WHERE reason='wants a person' ORDER BY created_at DESC LIMIT 5`);
      observed.guest_handover = { rows, discovery: rt.discoveryTenantId, full: full.tenantId, tools: turn.tools };
      expect(turn.tools).toContain('request_human_handover');
      const tenants = rows.map((r: any) => r.tenantId);
      expect(tenants).toContain(full.tenantId);
      expect(tenants).not.toContain(rt.discoveryTenantId);
      handoverId = rows.find((r: any) => r.tenantId === full.tenantId).id;
      clinicConversationId = rows.find((r: any) => r.tenantId === full.tenantId).conversationId;
      const result = lastToolResult(reactive.capturedRequests, 'request_human_handover');
      expect(result.success).toBe(true);
      expect(result.handoverId).toBe(handoverId);
    });

    it('the clinic gets a support conversation, the guest\'s AI conversation stays in the discovery tenant and is paused, linked to it', async () => {
      const { full } = rt.seed;
      const k = (await q(`SELECT "tenantId", type, owner_type FROM conversations WHERE id = $1`, [clinicConversationId]))[0];
      expect(k).toMatchObject({ tenantId: full.tenantId, type: 'support', owner_type: 'HUMAN' });
      const ai = (await q(`SELECT "tenantId", "conversationId", status FROM ai_conversations WHERE id = $1`, [g.conversationId]))[0];
      expect(ai).toMatchObject({ tenantId: rt.discoveryTenantId, conversationId: clinicConversationId, status: 'HANDED_OVER' });
    });

    it('the agent opens the conversation to context: the guest\'s chat so far was copied into the clinic\'s conversation, in the CLINIC\'s tenant', async () => {
      const { full } = rt.seed;
      const msgs = await q(`SELECT "tenantId", sender_type, content FROM messages WHERE "conversationId" = $1 ORDER BY created_at ASC`, [clinicConversationId]);
      observed.seeded = msgs;
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs.every((m: any) => m.tenantId === full.tenantId)).toBe(true);
      expect(msgs.some((m: any) => m.sender_type === 'CUSTOMER' && m.content.includes('I want to talk to the clinic staff'))).toBe(true);
    });

    it('the clinic\'s inbox is notified through the CLINIC\'s tenant room, carrying the guest\'s AI conversation id', () => {
      const { full } = rt.seed;
      const requested = sink.find((s) => s.event === 'ai:handover' && s.payload.type === 'requested');
      expect(requested?.room).toBe(room.tenant(full.tenantId));
      expect(requested?.payload.aiConversationId).toBe(g.conversationId);
      expect(sink.some((s) => s.room === room.tenant(rt.discoveryTenantId))).toBe(false);
    });

    it('the clinic can list the request and resolve the guest\'s AI conversation from its own conversation', async () => {
      const { full } = rt.seed;
      const list = await handoverSvc().findAll(full.tenantId, { page: 1, limit: 50 } as any);
      expect(list.data.map((h) => h.id)).toContain(handoverId);
      const latest = await handoverSvc().findLatestForConversation(full.tenantId, clinicConversationId);
      expect(latest?.aiConversationId).toBe(g.conversationId);
    });

    it('while handed over, the guest keeps talking: the model is NOT called, and the message reaches the clinic\'s conversation and notification', async () => {
      const { full } = rt.seed;
      const before = reactive.capturedRequests.length;
      const r = await guestSays('is anyone there?');
      expect(reactive.capturedRequests.length).toBe(before); // AI is paused
      expect(r.errors).toEqual([]);
      const msgs = await q(`SELECT "tenantId", sender_type, content FROM messages WHERE "conversationId" = $1 AND content = 'is anyone there?'`, [clinicConversationId]);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ tenantId: full.tenantId, sender_type: 'CUSTOMER' });
      const aiMsgs = await q(`SELECT "tenantId" FROM ai_messages WHERE ai_conversation_id::text = $1 AND content = 'is anyone there?'`, [g.conversationId]);
      expect(aiMsgs.map((m: any) => m.tenantId)).toEqual([rt.discoveryTenantId]); // the guest's own history stays in the guest's tenant
    });

    it('clinic staff (with the inbox permission and a request on it) join the guest\'s room, and reply — the guest receives it', async () => {
      const { full } = rt.seed;
      await handoverSvc().assign(full.tenantId, handoverId, { assignedToUserId: staffUser.id } as any);
      await handoverSvc().accept(full.tenantId, handoverId, staffUser.id);
      const joined = await gateway().onJoin(staff as any, { aiConversationId: g.conversationId! });
      expect(joined).toEqual({ joined: g.conversationId });

      sink = [];
      const reply = await gateway().onAgentReply(staff as any, { aiConversationId: g.conversationId!, content: 'Hello, this is the clinic.' });
      expect(reply).toMatchObject({ ok: true });

      const toGuest = sink.find((s) => s.event === 'ai:agent:message' && s.room === room.conversation(g.conversationId!));
      expect(toGuest?.payload).toMatchObject({ aiConversationId: g.conversationId, content: 'Hello, this is the clinic.' });
      const timeline = await q(`SELECT "tenantId", sender_type FROM messages WHERE "conversationId" = $1 AND content = 'Hello, this is the clinic.'`, [clinicConversationId]);
      expect(timeline).toEqual([{ tenantId: full.tenantId, sender_type: 'AGENT' }]);
      const aiRow = await q(`SELECT "tenantId", agent_user_id FROM ai_messages WHERE ai_conversation_id::text = $1 AND content = 'Hello, this is the clinic.'`, [g.conversationId]);
      expect(aiRow).toEqual([{ tenantId: rt.discoveryTenantId, agent_user_id: staffUser.id }]);
    });

    it('ISOLATION: another clinic\'s staff cannot join, type into, or reply to that guest conversation', async () => {
      const { b } = rt.seed;
      const other = fakeSocket(await ownerPrincipal(rt, b));
      expect(await gateway().onJoin(other as any, { aiConversationId: g.conversationId! })).toEqual({ joined: null });
      expect(await gateway().onAgentReply(other as any, { aiConversationId: g.conversationId!, content: 'intruder' })).toEqual({ ok: false });
      expect(await handoverSvc().canAgentAccess(b.tenantId, g.conversationId!)).toBe(false);
      expect((await handoverSvc().findAll(b.tenantId, { page: 1, limit: 50 } as any)).data.map((h) => h.id)).not.toContain(handoverId);
      const leaked = await q(`SELECT 1 FROM messages WHERE content = 'intruder'`);
      expect(leaked).toHaveLength(0);
    });

    it('ISOLATION: another guest cannot escalate, join or hijack that conversation', async () => {
      const stranger = fakeSocket(await mintGuest(rt.harness));
      expect(await gateway().onHandover(stranger as any, { aiConversationId: g.conversationId! })).toEqual({ ok: false });
      expect(await gateway().onJoin(stranger as any, { aiConversationId: g.conversationId! })).toEqual({ joined: null });
    });

    it('ISOLATION: the same clinic\'s staff cannot reach a DIFFERENT guest conversation that has no handover request', async () => {
      const { full } = rt.seed;
      scriptHandover(null);
      const other = await GuestSession.start(rt);
      reactive.setHandler(() => ({ content: 'hello' }));
      await other.say('just browsing');
      expect(await gateway().onJoin(staff as any, { aiConversationId: other.conversationId! })).toEqual({ joined: null });
      expect(await handoverSvc().canAgentAccess(full.tenantId, other.conversationId!)).toBe(false);
    });

    it('return-to-AI resumes the guest\'s assistant in the guest\'s tenant and removes the cross-tenant link', async () => {
      const { full } = rt.seed;
      sink = [];
      await handoverSvc().returnToAi(full.tenantId, handoverId);
      const ai = (await q(`SELECT "tenantId", "conversationId", status FROM ai_conversations WHERE id = $1`, [g.conversationId]))[0];
      expect(ai).toMatchObject({ tenantId: rt.discoveryTenantId, conversationId: null, status: 'ACTIVE' });
      expect(sink.some((s) => s.event === 'ai:handover' && s.payload.type === 'returned_to_ai' && s.room === room.conversation(g.conversationId!))).toBe(true);
      // the clinic keeps its conversation and history
      const kept = await q(`SELECT count(*)::int c FROM messages WHERE "conversationId" = $1`, [clinicConversationId]);
      expect(kept[0].c).toBeGreaterThan(2);

      reactive.setHandler(() => ({ content: 'Back with the assistant.' }));
      const before = reactive.capturedRequests.length;
      const r = await guestSays('thanks, one more question');
      expect(reactive.capturedRequests.length).toBeGreaterThan(before); // AI answers again
      expect(r.reply).toBe('Back with the assistant.');
      expect(r.errors).toEqual([]);
      const mirrored = await q(`SELECT 1 FROM messages WHERE "conversationId" = $1 AND content = 'thanks, one more question'`, [clinicConversationId]);
      expect(mirrored).toHaveLength(0); // no longer mirrored into the clinic's conversation
      // and clinic staff lost access with the link
      expect(await gateway().onJoin(staff as any, { aiConversationId: g.conversationId! })).toEqual({ joined: null });
    });

    it('a guest who has NOT chosen a clinic is refused honestly: nothing is filed in any tenant and the assistant stays active', async () => {
      const before = (await q(`SELECT count(*)::int c FROM handover_requests`))[0].c;
      const noClinic = await GuestSession.start(rt);
      scriptHandover(null);
      const turn = await noClinic.say('I want a human');
      const result = lastToolResult(reactive.capturedRequests, 'request_human_handover');
      observed.no_clinic = result;
      expect(turn.tools).toContain('request_human_handover');
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/clinic/i);
      expect((await q(`SELECT count(*)::int c FROM handover_requests`))[0].c).toBe(before);
      const ai = (await q(`SELECT status, "conversationId" FROM ai_conversations WHERE id = $1`, [noClinic.conversationId]))[0];
      expect(ai).toMatchObject({ status: 'ACTIVE', conversationId: null });
    });

    it('a second request while already waiting returns the SAME request — no second conversation is opened', async () => {
      const { full } = rt.seed;
      const twice = await GuestSession.start(rt);
      scriptHandover(full.tenantId);
      await twice.say('human please');
      const first = (await q(`SELECT id, "conversationId" FROM handover_requests WHERE "conversationId" = (SELECT "conversationId" FROM ai_conversations WHERE id = $1)`, [twice.conversationId]))[0];
      const again = await gateway().onHandover(fakeSocket(twice.user) as any, { aiConversationId: twice.conversationId!, reason: 'again' });
      expect(again).toMatchObject({ ok: true, handoverId: first.id });
      const rows = await q(`SELECT count(*)::int c FROM handover_requests WHERE "conversationId" = $1`, [first.conversationId]);
      expect(rows[0].c).toBe(1);
    });

    it('the socket path (ai:handover from the widget button) routes exactly like the tool', async () => {
      const { full } = rt.seed;
      const viaSocket = await GuestSession.start(rt);
      reactive.setHandler((req) =>
        req.messages.some((m) => m.role === 'tool' && m.name === 'select_clinic') ? { content: 'ok' } : { toolCalls: [scriptedToolCall('select_clinic', { clinicId: full.tenantId })] },
      );
      await viaSocket.say('tell me about the clinic');
      const res = await gateway().onHandover(fakeSocket(viaSocket.user) as any, { aiConversationId: viaSocket.conversationId!, reason: 'button' });
      expect(res).toMatchObject({ ok: true });
      const row = (await q(`SELECT "tenantId" FROM handover_requests WHERE id = $1`, [(res as any).handoverId]))[0];
      expect(row.tenantId).toBe(full.tenantId);
    });

    it('a WhatsApp / staff turn is unchanged: the request is filed under the conversation\'s own tenant', async () => {
      const { full } = rt.seed;
      const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
      const res = (await rt.dispatch.execute(ctx, call('request_human_handover', { reason: 'wa wants a person' }))) as Record<string, any>;
      expect(res.success).toBe(true);
      const row = (await q(`SELECT "tenantId" FROM handover_requests WHERE id = $1`, [res.handoverId]))[0];
      expect(row.tenantId).toBe(full.tenantId);
      const ai = (await q(`SELECT "tenantId" FROM ai_conversations WHERE id = $1`, [ctx.aiConversationId]))[0];
      expect(ai.tenantId).toBe(full.tenantId);
    });
  });
});
