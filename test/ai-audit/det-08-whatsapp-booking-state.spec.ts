/**
 * Phase 1 regression suite — conversation state and the tool loop.
 *
 *   F-28  WhatsApp tool results are not replayed, so every turn re-discovered ids from the top
 *   F-15  the tool loop ended on the LAST tool round with a canned reply, hiding what that round did
 *   F-26  a service with no published price could be answered with a number the model was never given
 *
 * The "model" is a deterministic double that plays the part a real one plays — it reads the tool
 * results and the pinned context block it is given and acts on them — so what these tests prove is
 * what the SERVER does: what it persists, what it shows back, what it refuses to show, and how the
 * loop ends. Nothing here says how a real model behaves; that is the live suite's job (run after
 * Phase 4, per the fix plan).
 *
 * Real path throughout: `WhatsappInboundAiService.handleInboundValue` → orchestrator →
 * `AiExecutionService` → dispatcher, real Postgres, real per-tenant bot actor. Only the outbound
 * Meta send is captured.
 */
import { scriptedToolCall as call } from '../security/fixtures/scripted-ai-provider';
import {
  bootAudit,
  GuestSession,
  gatewayTurn,
  ownerPrincipal,
  whatsappTurn,
  whatsappToolCtx,
  saveEvidence,
  type AuditRuntime,
} from './fixtures/audit-runtime';
import { ConversationSessionService } from '../../src/modules/ai-orchestrator/conversation-session.service';
import { ReactiveProvider, toolResultsIn } from './fixtures/reactive-provider';
import type { AiCompletionRequest } from '../../src/modules/ai/providers/ai-provider.interface';

const CONTEXT_HEADER = 'ESTABLISHED BOOKING CONTEXT';

const systemMessages = (req: AiCompletionRequest) =>
  req.messages.filter((m) => m.role === 'system').map((m) => m.content ?? '');
const contextBlock = (req: AiCompletionRequest) =>
  systemMessages(req).find((s) => s.startsWith(CONTEXT_HEADER));
const uuidAfter = (text: string, label: RegExp) =>
  text.match(
    new RegExp(`${label.source}[^\\n]*?\\(id ([0-9a-f-]{36})\\)`, 'i'),
  )?.[1];
const resultOf = (req: AiCompletionRequest, name: string) =>
  toolResultsIn(req).find((r) => r.name === name)?.json;

describe('Phase 1 — WhatsApp booking state, tool loop and price honesty', () => {
  let rt: AuditRuntime;
  let reactive: ReactiveProvider;
  const observed: Record<string, any> = {};
  const q = (sql: string, p: unknown[] = []) =>
    rt.harness.dataSource.query(sql, p);
  const sessions = () => rt.harness.app.get(ConversationSessionService);

  /** The AI conversation the most recent tool call of this tenant ran in. */
  async function lastConversation(tenantId: string): Promise<string> {
    const rows = await q(
      `SELECT ai_conversation_id FROM ai_tool_calls WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    );
    return rows[0].ai_conversation_id as string;
  }
  const sessionOf = async (convId: string) =>
    (await q(`SELECT session FROM ai_conversations WHERE id = $1`, [convId]))[0]
      ?.session ?? {};

  beforeAll(async () => {
    rt = await bootAudit();
    reactive = new ReactiveProvider();
    rt.use(reactive);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-08-whatsapp-booking-state', observed);
    await rt?.close();
  }, 60_000);

  // ── F-28 ───────────────────────────────────────────────────────────────────
  describe('F-28 — the booking working set survives the turn', () => {
    let convId: string;
    let secondTurnRequests: readonly AiCompletionRequest[];

    it('turn 1: the patient asks for a cleaning; the model discovers branch → doctors + services → availability, and the server records the branch and doctor it worked on', async () => {
      const { full } = rt.seed;
      reactive.setHandler((req) => {
        const branches = resultOf(req, 'list_clinic_branches');
        if (!branches) return { toolCalls: [call('list_clinic_branches', {})] };
        const main = (branches.branches as any[]).find(
          (b) => b.name === 'Main Branch',
        );
        if (!resultOf(req, 'list_clinic_doctors')) {
          return {
            toolCalls: [
              call('list_clinic_doctors', { branchId: main.id }),
              call('list_clinic_services', { branchId: main.id }),
            ],
          };
        }
        const omar = (
          resultOf(req, 'list_clinic_doctors').doctors as any[]
        ).find((d) => d.name.includes('Omar'));
        if (!resultOf(req, 'check_availability')) {
          return {
            toolCalls: [
              call('check_availability', {
                branchId: main.id,
                staffId: omar.id,
                daysAhead: 3,
                slotMinutes: 45,
              }),
            ],
          };
        }
        return {
          content: 'Dr. Omar has several times open. Which one suits you?',
        };
      });

      const r = await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.x,
        'I want a dental cleaning with Dr. Omar at the Main Branch',
      );
      observed.turn1 = {
        tools: r.tools,
        replies: r.replies,
        providerCalls: reactive.capturedRequests.length,
      };

      expect(r.tools).toEqual([
        'list_clinic_branches',
        'list_clinic_doctors',
        'list_clinic_services',
        'check_availability',
      ]);
      // Nothing has been worked on yet, so a first turn's block is the DATE alone:
      // no ids, no services — but "tomorrow" is never left to the model's memory.
      for (const req of reactive.capturedRequests) {
        const block = contextBlock(req);
        expect(block).toMatch(/- today: \d{4}-\d{2}-\d{2} \(\w+, /);
        expect(block).not.toContain('(id ');
        expect(block).not.toContain('- branch:');
      }

      convId = await lastConversation(full.tenantId);
      const session = await sessionOf(convId);
      expect(session.selectedBranchId).toBe(full.branchId);
      expect(session.selectedDoctorId).toBe(full.doctorStaffIds.omar);
    });

    it('turn 2: the pinned block carries the ids, every service with its real price, and says the unpriced one has none', async () => {
      const { full } = rt.seed;
      reactive.setHandler(() => ({ content: 'ok' }));

      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.x,
        'yes, the first one please',
      );
      secondTurnRequests = reactive.capturedRequests;
      const block = contextBlock(reactive.capturedRequests[0]);
      observed.turn2_block = block;

      // Same conversation — the state has somewhere to live.
      expect(await lastConversation(full.tenantId)).toBe(convId);
      expect(block).toBeDefined();
      expect(uuidAfter(block!, /- branch: /)).toBe(full.branchId);
      expect(uuidAfter(block!, /doctor last used: /)).toBe(
        full.doctorStaffIds.omar,
      );
      expect(uuidAfter(block!, /Dental Cleaning/)).toBe(
        full.serviceIds.cleaning,
      );
      // F-26: the real, published prices — and NO number at all for the unpriced service.
      expect(block).toMatch(
        /Dental Cleaning \(id [0-9a-f-]{36}\): 45 min, price 250/,
      );
      expect(block).toMatch(
        /Teeth Whitening \(id [0-9a-f-]{36}\): 60 min, price 500/,
      );
      expect(block).toMatch(
        /General Consultation \(id [0-9a-f-]{36}\): 30 min, price NOT PUBLISHED/,
      );
      expect(block).toContain(
        `other branches: North Branch (id ${full.branch2Id})`,
      );
      // It is a SYSTEM message, sitting right after the platform prompt.
      expect(systemMessages(reactive.capturedRequests[0])[1]).toBe(block);
    });

    it('turn 2 (continued): a model that uses the block books in 2 tool rounds with NO discovery calls — the flow the old 4-round loop could not finish', async () => {
      const { full } = rt.seed;
      reactive.setHandler((req) => {
        const block = contextBlock(req)!;
        const branchId = uuidAfter(block, /- branch: /)!;
        const staffId = uuidAfter(block, /doctor last used: /)!;
        const serviceId = uuidAfter(block, /Dental Cleaning/)!;
        const avail = resultOf(req, 'check_availability');
        if (!avail) {
          return {
            toolCalls: [
              call('check_availability', {
                branchId,
                staffId,
                daysAhead: 3,
                slotMinutes: 45,
              }),
            ],
          };
        }
        if (!resultOf(req, 'book_appointment')) {
          const slot = (avail.days as any[])[0].slots[2].startAt;
          return {
            toolCalls: [
              call('book_appointment', {
                branchId,
                staffId,
                startAt: slot,
                serviceIds: [serviceId],
                hasInsurance: false,
              }),
            ],
          };
        }
        return {
          content: `Booked for ${resultOf(req, 'book_appointment').startAt}.`,
        };
      });

      const r = await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.x,
        'the third time works, no insurance',
      );
      observed.turn2_booking = {
        tools: r.tools,
        replies: r.replies,
        providerCalls: reactive.capturedRequests.length,
      };

      expect(r.tools).toEqual(['check_availability', 'book_appointment']); // no list_clinic_* — the block replaced them
      expect(reactive.capturedRequests).toHaveLength(3);
      const booked = await q(
        `SELECT "customerId", "staffId", "branchId" FROM appointments WHERE "tenantId" = $1 AND source = 'WHATSAPP_BOT' AND "customerId" = $2`,
        [full.tenantId, full.patientIds.x],
      );
      expect(booked).toHaveLength(1);
      expect(booked[0].staffId).toBe(full.doctorStaffIds.omar);
      expect(booked[0].branchId).toBe(full.branchId);
      expect(r.replies.join(' ')).toMatch(/^Booked for /);
    });

    it('a clinic with SEVERAL branches: list_clinic_branches alone pins nothing (the patient has not chosen), so the next turn block is the date alone', async () => {
      const { full } = rt.seed;
      reactive.setHandler((req) =>
        resultOf(req, 'list_clinic_branches')
          ? { content: 'Main Branch or North Branch?' }
          : { toolCalls: [call('list_clinic_branches', {})] },
      );
      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'I need to book something',
      );
      const convY = await lastConversation(full.tenantId);
      expect((await sessionOf(convY)).selectedBranchId).toBeUndefined();

      reactive.setHandler(() => ({ content: 'ok' }));
      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'Main Branch',
      );
      // Still no branch pinned — only the date.
      const block = contextBlock(reactive.capturedRequests[0]);
      expect(block).toMatch(/- today: \d{4}-\d{2}-\d{2}/);
      expect(block).not.toContain('- branch:');
    });

    it('a clinic with ONE branch pins it from list_clinic_branches alone, and the next turn shows it', async () => {
      const { empty } = rt.seed;
      const phone = '966555000911';
      reactive.setHandler((req) =>
        resultOf(req, 'list_clinic_branches')
          ? { content: 'We have one branch.' }
          : { toolCalls: [call('list_clinic_branches', {})] },
      );
      await whatsappTurn(rt, empty.tenantId, phone, 'where can I book?');
      const convE = await lastConversation(empty.tenantId);
      expect((await sessionOf(convE)).selectedBranchId).toBe(empty.branchId);

      reactive.setHandler(() => ({ content: 'ok' }));
      await whatsappTurn(rt, empty.tenantId, phone, 'ok');
      const block = contextBlock(reactive.capturedRequests[0]);
      expect(uuidAfter(block!, /- branch: /)).toBe(empty.branchId);
      // Nothing entered for this clinic, so nothing is listed — and nothing is invented.
      expect(block).not.toContain('services at this branch');
      expect(block).not.toContain('doctors at this branch');
    });
  });

  // ── isolation ──────────────────────────────────────────────────────────────
  describe('F-28 — the working set never crosses a tenant or a transport', () => {
    it('a branch of ANOTHER clinic is refused by the tool and never recorded', async () => {
      const { full, b } = rt.seed;
      reactive.setHandler((req) =>
        resultOf(req, 'list_clinic_doctors')
          ? { content: 'ok' }
          : {
              toolCalls: [
                call('list_clinic_doctors', { branchId: b.branchId }),
              ],
            },
      );

      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'list the doctors of that other branch',
      );

      expect(
        resultOf(reactive.capturedRequests[1], 'list_clinic_doctors').success,
      ).toBe(false);
      const conv = await lastConversation(full.tenantId);
      expect((await sessionOf(conv)).selectedBranchId).toBeUndefined();
    });

    it("even a session that HAS another clinic's branch recorded (stale, tampered, or written by a bug) is never shown to the model", async () => {
      const { full, b } = rt.seed;
      const conv = await lastConversation(full.tenantId);
      await sessions().patch(full.tenantId, conv, {
        selectedBranchId: b.branchId,
        selectedDoctorId: b.doctorStaffIds.canary,
      } as never);
      reactive.setHandler(() => ({ content: 'ok' }));

      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'hello again',
      );

      const everything = JSON.stringify(reactive.capturedRequests[0].messages);
      expect(contextBlock(reactive.capturedRequests[0])).toBeUndefined();
      for (const canary of [
        b.branchId,
        b.doctorStaffIds.canary,
        b.serviceIds.canary,
        'CANARY',
      ]) {
        expect(everything).not.toContain(canary);
      }
    });

    it('a staff (dashboard) turn records nothing and gets no block, even when it uses the same tools', async () => {
      const { full } = rt.seed;
      const owner = await ownerPrincipal(rt, full);
      reactive.setHandler((req) =>
        resultOf(req, 'check_availability')
          ? { content: 'checked' }
          : {
              toolCalls: [
                call('check_availability', {
                  branchId: full.branchId,
                  staffId: full.doctorStaffIds.omar,
                  daysAhead: 2,
                  slotMinutes: 45,
                }),
              ],
            },
      );

      const r = await gatewayTurn(rt, owner, {
        content: 'is Dr. Omar free soon?',
        channel: 'DASHBOARD',
      });

      expect(r.errors).toEqual([]);
      expect(reactive.capturedRequests.every((req) => !contextBlock(req))).toBe(
        true,
      );
      const session = await sessionOf(r.aiConversationId!);
      expect(session.selectedBranchId).toBeUndefined();
      expect(session.selectedDoctorId).toBeUndefined();
    });
  });

  // ── F-26 ───────────────────────────────────────────────────────────────────
  describe('F-26 — an unpriced service is never given a price', () => {
    it('the WhatsApp service list names the state (NOT_PUBLISHED / PUBLISHED) exactly as the public one does', async () => {
      const { full } = rt.seed;
      const ctx = await whatsappToolCtx(rt, full, full.patientIds.x);
      const res = await rt.dispatch.execute(
        ctx,
        call('list_clinic_services', { branchId: full.branchId }),
      );
      const byName = Object.fromEntries(
        (res.services as any[]).map((s) => [s.name, s]),
      );
      observed.wa_services_priceStatus = byName;

      expect(byName['General Consultation']).toMatchObject({
        price: null,
        priceStatus: 'NOT_PUBLISHED',
      });
      expect(byName['Dental Cleaning']).toMatchObject({
        price: 250,
        priceStatus: 'PUBLISHED',
      });
      expect(res.guidance).toMatch(
        /NEVER call it free and NEVER state a number/,
      );
    });

    it('the WhatsApp prompt carries the rule: state a price only if a tool returned it this turn or the block lists it', async () => {
      const { full } = rt.seed;
      reactive.setHandler(() => ({ content: 'ok' }));
      await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'how much is a consultation?',
      );
      const prompt = systemMessages(reactive.capturedRequests[0])[0];
      expect(prompt).toContain(
        'State a price, time, address or doctor only if a tool returned it this turn',
      );
      expect(prompt).toContain('priceStatus NOT_PUBLISHED');
    });
  });

  // ── F-15 ───────────────────────────────────────────────────────────────────
  describe('F-15 — the last tool round is no longer thrown away', () => {
    it('WhatsApp: the mandated chain (branches → doctors + services → availability → BOOK) needs 4 tool rounds, and the patient is told the outcome of the last one', async () => {
      const { full } = rt.seed;
      const phone = '966555000922'; // a fresh patient — no pinned state to shortcut the chain
      const requests: AiCompletionRequest[] = [];
      reactive.setHandler((req) => {
        requests.push(req);
        const branches = resultOf(req, 'list_clinic_branches');
        if (!branches) return { toolCalls: [call('list_clinic_branches', {})] };
        const main = (branches.branches as any[]).find(
          (b) => b.name === 'Main Branch',
        );
        if (!resultOf(req, 'list_clinic_doctors')) {
          return {
            toolCalls: [
              call('list_clinic_doctors', { branchId: main.id }),
              call('list_clinic_services', { branchId: main.id }),
            ],
          };
        }
        const omar = (
          resultOf(req, 'list_clinic_doctors').doctors as any[]
        ).find((d) => d.name.includes('Omar'));
        const cleaning = (
          resultOf(req, 'list_clinic_services').services as any[]
        ).find((s) => s.name === 'Dental Cleaning');
        const avail = resultOf(req, 'check_availability');
        if (!avail) {
          return {
            toolCalls: [
              call('check_availability', {
                branchId: main.id,
                staffId: omar.id,
                daysAhead: 3,
                slotMinutes: 45,
              }),
            ],
          };
        }
        if (!resultOf(req, 'book_appointment')) {
          const slot = (avail.days as any[])[0].slots[3].startAt;
          return {
            toolCalls: [
              call('book_appointment', {
                branchId: main.id,
                staffId: omar.id,
                startAt: slot,
                serviceIds: [cleaning.id],
                hasInsurance: false,
              }),
            ],
          };
        }
        return {
          content: `Your appointment is booked for ${resultOf(req, 'book_appointment').startAt}.`,
        };
      });

      const r = await whatsappTurn(
        rt,
        full.tenantId,
        phone,
        'Book me a dental cleaning with Dr. Omar at the Main Branch, my name is Salma, no insurance',
      );
      observed.chain = {
        tools: r.tools,
        replies: r.replies,
        providerCalls: requests.length,
      };

      expect(r.tools).toEqual([
        'list_clinic_branches',
        'list_clinic_doctors',
        'list_clinic_services',
        'check_availability',
        'book_appointment',
      ]);
      // 4 tool rounds + the tool-less wrap-up.
      expect(requests).toHaveLength(5);
      expect((requests[4].tools ?? []).length).toBe(0);
      expect(
        requests[4].messages.some(
          (m) => m.role === 'tool' && m.name === 'book_appointment',
        ),
      ).toBe(true);

      const startAt = resultOf(requests[4], 'book_appointment')
        .startAt as string;
      const rows = await q(
        `SELECT a.id FROM appointments a JOIN customers c ON c.id = a."customerId"
          WHERE a."tenantId" = $1 AND a.source = 'WHATSAPP_BOT' AND c.phone LIKE $2`,
        [full.tenantId, `%${phone.slice(-9)}`],
      );
      expect(rows).toHaveLength(1);
      // The patient is told about THAT booking — not "I have processed your request."
      expect(r.replies.join(' ')).toContain('Your appointment is booked for');
      expect(r.replies.join(' ')).toContain(startAt.slice(0, 16));
      expect(r.replies.join(' ')).not.toContain(
        'I have processed your request',
      );
    });

    it('WhatsApp: a model that never stops calling tools ends with the fixed fallback — sent to the patient in both languages, claiming nothing', async () => {
      const { full } = rt.seed;
      reactive.setHandler(() => ({
        toolCalls: [call('list_clinic_branches', {})],
      }));

      const r = await whatsappTurn(
        rt,
        full.tenantId,
        full.patientPhones!.y,
        'loop',
      );
      const text = r.replies.join(' ');
      observed.exhausted_whatsapp = {
        providerCalls: reactive.capturedRequests.length,
        text,
      };

      expect(reactive.capturedRequests).toHaveLength(5);
      expect(text).toContain('could not finish that reply');
      expect(text).toContain('لم أتمكن من إكمال الرد');
      expect(text).not.toMatch(
        /processed your request|booked|confirmed|cancelled/i,
      );
    });

    it('the third loop — a provider with NO streaming support — ends the same way: 4 tool rounds, one tool-less wrap-up, then either its answer or the fixed fallback', async () => {
      const complete = (
        handler: ConstructorParameters<typeof ReactiveProvider>[0],
      ) => {
        const p = new ReactiveProvider(handler);
        (p as unknown as { stream?: unknown }).stream = undefined; // AiExecutionService then takes the complete()-based loop
        return p;
      };

      const looping = complete(() => ({
        toolCalls: [call('list_cities', {})],
      }));
      rt.use(looping);
      const g1 = await GuestSession.start(rt);
      const exhausted = await g1.say('loop forever');
      expect(looping.capturedRequests).toHaveLength(5);
      expect(exhausted.reply).toContain('could not finish that reply');
      expect(exhausted.reply).not.toBe('I have processed your request.');

      const answering = complete((req) =>
        (req.tools ?? []).length === 0
          ? { content: 'Here is what I found.' }
          : { toolCalls: [call('list_cities', {})] },
      );
      rt.use(answering);
      const g2 = await GuestSession.start(rt);
      const answered = await g2.say('keep looking');
      expect(answered.reply).toBe('Here is what I found.');
      expect(answering.capturedRequests).toHaveLength(5);

      rt.use(reactive);
    });
  });
});
