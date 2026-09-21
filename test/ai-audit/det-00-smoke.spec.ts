/**
 * Audit infra smoke test — proves the seed and both drivers work BEFORE any
 * finding is asserted on top of them. Not a finding itself.
 */
import { bootAudit, GuestSession, whatsappTurn, scriptTurns, type AuditRuntime } from './fixtures/audit-runtime';

describe('audit infra smoke', () => {
  let rt: AuditRuntime;
  beforeAll(async () => {
    rt = await bootAudit();
  }, 180_000);
  afterAll(async () => {
    await rt?.close();
  }, 60_000);

  it('seed: FULL clinic is discoverable, EMPTY exists, B carries canary data', async () => {
    const q = (sql: string, p: unknown[] = []) => rt.harness.dataSource.query(sql, p);
    expect((await q(`SELECT count(*)::int c FROM services WHERE "tenantId"=$1`, [rt.seed.full.tenantId]))[0].c).toBe(3);
    expect((await q(`SELECT count(*)::int c FROM services WHERE "tenantId"=$1`, [rt.seed.empty.tenantId]))[0].c).toBe(0);
    expect((await q(`SELECT name FROM tenants WHERE id=$1`, [rt.seed.b.tenantId]))[0].name).toMatch(/^CANARYCLINIC-/);
  });

  it('guest driver: a scripted reply reaches the widget via the REAL gateway', async () => {
    scriptTurns(rt, [{ content: 'Hello from the scripted model.' }]);
    const g = await GuestSession.start(rt);
    const r = await g.say('hi');
    expect(r.errors).toEqual([]);
    expect(r.reply).toContain('scripted model');
    expect(g.conversationId).toBeTruthy();
    // the model actually received the platform default PUBLIC prompt (no agent row exists)
    const sys = rt.provider.capturedRequests[0].messages.find((m) => m.role === 'system');
    expect(sys?.content).toContain('CLINICAL SAFETY');
    expect(sys?.content).toContain('ESTABLISHED BOOKING CONTEXT');
  });

  it('whatsapp driver: inbound message → real bridge → captured outbound reply (Meta never called)', async () => {
    scriptTurns(rt, [{ content: 'Hello from clinic FULL.' }]);
    const r = await whatsappTurn(rt, rt.seed.full.tenantId, `9665${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, 'hello');
    expect(r.replies.join(' ')).toContain('Hello from clinic FULL');
    const sys = rt.provider.capturedRequests[0].messages.find((m) => m.role === 'system');
    expect(sys?.content).toContain('THIS IS ONE CLINIC, ON ITS OWN WHATSAPP NUMBER');
  });
});
