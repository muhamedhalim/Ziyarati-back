/**
 * The WhatsApp AI bot actor — F-25 (Critical). REGRESSION suite: this file used to prove the defect and was
 * converted after the Phase 0 fix (2026-09-21).
 *
 * Original symptom (found by the live run): after several minutes on one clinic every inbound WhatsApp message
 * stopped getting a reply. No error reached the patient; the only trace was the log line
 * "inbound AI turn failed: A role with this slug already exists".
 *
 * Root cause: `WhatsappBotActorService.ensureBotActor` caches the principal for 60 s. On the next refresh
 * `ensureBotRole` looked the role up with `RolesService.findAll(...)` + `r.tenant?.id === tenantId`, but `findAll`
 * does not load the `tenant` relation, so the lookup could never match, `roles.create` was called again and
 * conflicted, and the catch-block re-check used the same broken predicate.
 *
 * Fix: the role is looked up by the same (tenant, slug) key `create` de-duplicates on
 * (`RolesService.findTenantRoleBySlug`); a failed inbound turn now tells the patient and raises a counter.
 *
 * Existing specs never saw it: they either stubbed `ensureBotActor` or finished inside the 60 s TTL. Every case
 * below therefore expires the cache explicitly, against the real database.
 */
import { bootAudit, whatsappTurn, saveEvidence, type AuditRuntime } from './fixtures/audit-runtime';
import { GuestSession } from './fixtures/audit-runtime';
import { ReactiveProvider, scriptedToolCall, lastToolResult } from './fixtures/reactive-provider';
import { WhatsappBotActorService } from '../../src/modules/whatsapp/whatsapp-bot-actor.service';
import { RolesService } from '../../src/modules/auth/roles.service';

describe('F-25 — WhatsApp bot actor re-provisioning (regression)', () => {
  let rt: AuditRuntime;
  let botActor: WhatsappBotActorService;
  const observed: Record<string, any> = {};

  beforeAll(async () => {
    rt = await bootAudit();
    botActor = rt.harness.app.get(WhatsappBotActorService);
  }, 180_000);
  afterAll(async () => {
    saveEvidence('det-07-bot-actor', observed);
    await rt?.close();
  }, 60_000);

  it('first provisioning works and is cached', async () => {
    const { full } = rt.seed;
    const a = await botActor.ensureBotActor(full.tenantId);
    const b = await botActor.ensureBotActor(full.tenantId); // cache hit
    expect(a.id).toBe(b.id);
    expect(a.permissions.length).toBeGreaterThan(0);
  });

  it('MECHANISM (why the lookup must not use findAll): findAll returns the tenant role WITHOUT its tenant relation, while findTenantRoleBySlug finds exactly that role', async () => {
    const { full } = rt.seed;
    const roles = rt.harness.app.get(RolesService);
    const all = await roles.findAll(full.tenantId);
    const botRole = all.find((r) => r.slug === 'ai-bot');
    observed.role_lookup = { slugs: all.map((r) => r.slug), botRoleTenant: (botRole as any)?.tenant ?? null };
    expect(botRole).toBeDefined(); // the role IS there...
    expect(botRole!.tenant).toBeUndefined(); // ...but `r.tenant?.id === tenantId` can never be true

    const byKey = await roles.findTenantRoleBySlug(full.tenantId, 'ai-bot');
    expect(byKey?.id).toBe(botRole!.id);
  });

  it('findTenantRoleBySlug is tenant-scoped: another clinic\'s role, a system role and an unknown slug are never returned', async () => {
    const { full, b } = rt.seed;
    const roles = rt.harness.app.get(RolesService);
    await botActor.ensureBotActor(b.tenantId);
    const mine = await roles.findTenantRoleBySlug(full.tenantId, 'ai-bot');
    const theirs = await roles.findTenantRoleBySlug(b.tenantId, 'ai-bot');
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(mine!.id).not.toBe(theirs!.id);
    expect(await roles.findTenantRoleBySlug(full.tenantId, 'owner')).toBeNull(); // system role, tenant-less
    expect(await roles.findTenantRoleBySlug(full.tenantId, 'no-such-role')).toBeNull();
  });

  it('F-25 FIXED: once the 60 s cache expires, ensureBotActor re-resolves the SAME role instead of throwing — repeatedly', async () => {
    const { full } = rt.seed;
    const first = await botActor.ensureBotActor(full.tenantId);
    const roleRows = async () =>
      rt.harness.dataSource.query(`SELECT count(*)::int c FROM roles WHERE slug = 'ai-bot' AND "tenantId" = $1`, [full.tenantId]);
    const before = await roleRows();
    for (let i = 0; i < 3; i += 1) {
      botActor.invalidate(full.tenantId); // what the 60 s TTL does on its own
      const again = await botActor.ensureBotActor(full.tenantId);
      expect(again.id).toBe(first.id);
      expect(again.permissions.slice().sort()).toEqual(first.permissions.slice().sort());
    }
    expect((await roleRows())[0].c).toBe(before[0].c); // no duplicate role row was created
    expect(before[0].c).toBe(1);
  });

  it('F-25 END-TO-END (WhatsApp): the patient gets the model\'s reply after the cache expired, and nothing is logged as a failure', async () => {
    const { full } = rt.seed;
    const reactive = new ReactiveProvider(() => ({ content: 'Our cancellation policy is 24 hours.' }));
    rt.use(reactive);
    botActor.invalidate(full.tenantId);
    const before = rt.logs.length;
    const r = await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'What is your cancellation policy?');
    observed.turn_after_expiry = { replies: r.replies, providerCalls: reactive.capturedRequests.length, logs: rt.logs.slice(before) };
    expect(r.replies).toEqual(['Our cancellation policy is 24 hours.']);
    expect(reactive.capturedRequests.length).toBeGreaterThanOrEqual(1);
    expect(rt.logs.slice(before).join(' ')).not.toMatch(/inbound AI turn failed|role with this slug/i);
  });

  it('F-25 END-TO-END (public booking): book_public_appointment succeeds after the cache expired, and the row exists', async () => {
    const { full } = rt.seed;
    const reactive = new ReactiveProvider();
    rt.use(reactive);
    const g = await GuestSession.start(rt);
    const step = async (tool: string, args: Record<string, unknown>) => {
      reactive.setHandler((req) => (req.messages.some((m) => m.role === 'tool' && m.name === tool) ? { content: 'ok' } : { toolCalls: [scriptedToolCall(tool, args)] }));
      await g.say(`(audit) ${tool}`);
      return lastToolResult(reactive.capturedRequests, tool);
    };
    await step('select_clinic', { clinicId: full.tenantId });
    await step('select_branch', { branchId: full.branchId });
    await step('select_service', { serviceIds: [full.serviceIds.cleaning] });
    await step('select_doctor', { staffId: full.doctorStaffIds.layla });
    const avail = await step('search_public_availability', { branchId: full.branchId, staffId: full.doctorStaffIds.layla, daysAhead: 5 });
    await step('select_slot', { startAt: avail.days[0].slots[0].startAt });
    botActor.invalidate(full.tenantId);
    const booked = await step('book_public_appointment', { fullName: 'Late Guest', phone: '966500900001' });
    observed.public_booking_after_expiry = booked;
    expect(booked.success).toBe(true);
    const rows = await rt.harness.dataSource.query(`SELECT count(*)::int c FROM appointments a JOIN customers c ON c.id=a."customerId" WHERE c.phone='966500900001'`);
    expect(rows[0].c).toBe(1);
  });

  it('the recovery is durable, not a one-off: every later inbound message is answered', async () => {
    const { full } = rt.seed;
    const reactive = new ReactiveProvider(() => ({ content: 'Happy to help.' }));
    rt.use(reactive);
    let sent = 0;
    for (let i = 0; i < 3; i += 1) {
      botActor.invalidate(full.tenantId);
      sent += (await whatsappTurn(rt, full.tenantId, full.patientPhones!.y, `message ${i}`)).replies.length;
    }
    expect(sent).toBe(3);
    expect(reactive.capturedRequests.length).toBeGreaterThanOrEqual(3);
  });

  it('a turn that DOES fail is no longer silent: the patient is told, the model is not called, and the failure is logged with the tenant', async () => {
    const { full } = rt.seed;
    const reactive = new ReactiveProvider(() => ({ content: 'should never be sent' }));
    rt.use(reactive);
    const spy = jest.spyOn(botActor, 'ensureBotActor').mockRejectedValueOnce(new Error('simulated provisioning outage'));
    const before = rt.logs.length;
    try {
      const r = await whatsappTurn(rt, full.tenantId, full.patientPhones!.x, 'Are you open on Sunday?');
      observed.failed_turn = { replies: r.replies, providerCalls: reactive.capturedRequests.length, logs: rt.logs.slice(before) };
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0]).toMatch(/could not process your message/i);
      expect(r.replies[0]).not.toMatch(/should never be sent/);
      expect(reactive.capturedRequests).toHaveLength(0);
      const logged = rt.logs.slice(before).join(' ');
      expect(logged).toMatch(new RegExp(`inbound AI turn failed \\(tenant=${full.tenantId}\\): simulated provisioning outage`));
      expect(logged).not.toContain(full.patientPhones!.x); // FND-016: no patient phone in logs
    } finally {
      spy.mockRestore();
    }
  });
});
