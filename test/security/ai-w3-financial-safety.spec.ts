/**
 * T099 — financial safety: script the model to emit payment amounts and
 * assert the persisted amount is SERVER-derived, never model-supplied; and
 * confirm zero AI-path payment-STATE transitions (the AI path can only ever
 * CREATE an inert, unpaid `PaymentLink` — never mark one paid/verified).
 *
 * Structural facts this file's assertions rest on, confirmed by reading
 * `ai-tool-dispatch.service.ts` end to end (T044/T045):
 *  - `book_appointment`'s schema (`ai-tools.constants.ts:159-187`) has NO
 *    amount/price/total field at all — only `serviceIds` (names, not prices).
 *  - The dispatcher's `bookAppointment()` never reads `args.amount`/
 *    `args.totalAmount`/anything monetary — `AppointmentsService.create`
 *    computes `total_amount` itself from `Service.base_price` /
 *    `service_prices`, entirely server-side.
 *  - `maybeCreatePaymentLink()` (`ai-tool-dispatch.service.ts:599-629`) calls
 *    `PaymentLinkService.create(tenantId, { appointmentId, amount })` where
 *    `amount = Number(appt.total_amount ?? 0)` — the JUST-COMPUTED,
 *    server-derived value, never anything from `args`.
 *  - `PaymentLinkService.create` (`payment-link.service.ts:39-89`) itself has
 *    a SECOND, independent server-side re-derivation: when `dto.appointmentId`
 *    is set it re-reads `appointment.total_amount` from the DB and REJECTS a
 *    mismatching `dto.amount` (`:59-68`) — belt and suspenders.
 *  - `AiToolDispatchService`'s constructor injects `PaymentLinkService` and
 *    calls only `.create()` — no `PaymentService`, no verify/capture/refund
 *    service is even injected, so no AI tool call can reach one.
 */
import { buildAiAuditHarness, type AiAuditHarness } from './fixtures/ai-audit-harness';
import { seedAiAudit, teardownAiAuditSeed, type AiAuditSeed } from './fixtures/ai-audit-seed';
import { scriptedToolCall } from './fixtures/scripted-ai-provider';
import { AiConversationService } from '../../src/modules/ai/ai-conversation.service';
import { AiToolDispatchService, ToolContext } from '../../src/modules/ai/tools/ai-tool-dispatch.service';
import { AI_TOOL, AI_TOOLS } from '../../src/modules/ai/tools/ai-tools.constants';
import { AI_ADMIN_TOOLS } from '../../src/modules/ai/tools/ai-admin-tools.constants';
import { AI_PUBLIC_BOOKING_TOOLS } from '../../src/modules/ai/tools/ai-public-booking-tools.constants';
import { PERMISSION } from '../../src/rbac/rbac.constants';
import { Service } from '../../src/entities/Services/Service';
import { Tenant } from '../../src/entities/SaaS-Core/Tenant';

const SERVICE_PRICE = 50;

describe('W3 — financial safety: server-derived amounts, zero AI-path payment transitions (T099)', () => {
  let harness: AiAuditHarness;
  let seed: AiAuditSeed;
  let conversations: AiConversationService;
  let dispatch: AiToolDispatchService;
  let serviceId: string;

  beforeAll(async () => {
    harness = await buildAiAuditHarness();
    seed = await seedAiAudit(harness.app, harness.dataSource);
    conversations = harness.app.get(AiConversationService);
    dispatch = harness.app.get(AiToolDispatchService);

    const services = harness.dataSource.getRepository(Service);
    const service = await services.save(
      services.create({ tenant: { id: seed.tenantA.id } as Tenant, name: 'T099 Priced Service', duration_minutes: 30, base_price: SERVICE_PRICE }),
    );
    serviceId = service.id;
    // `TenantService.getSettings` auto-creates a settings row defaulting
    // `payment_required = true` (`TenantSetting.ts:22-23`) — no explicit
    // insert needed for THIS test's purpose (an uninsured, priced booking
    // must generate a payment link to exercise the amount-integrity path).
  }, 120_000);

  afterAll(async () => {
    await harness.dataSource.query(`DELETE FROM services WHERE id = $1`, [serviceId]).catch(() => undefined);
    await teardownAiAuditSeed(harness.dataSource, seed);
    await harness.close();
  }, 60_000);

  async function cleanupAppointment(appointmentId: string) {
    await harness.dataSource.query(`DELETE FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointment_services WHERE "appointmentId" = $1`, [appointmentId]).catch(() => undefined);
    await harness.dataSource.query(`DELETE FROM appointments WHERE id = $1`, [appointmentId]).catch(() => undefined);
  }

  it('scripted model emits WILDLY different monetary values (amount, totalAmount, price, discount) — the persisted appointment total_amount is EXACTLY the server-computed service price, never any injected value', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: seed.tenantA.staffUserId, permissions: [PERMISSION.APPOINTMENTS_CREATE] };

    const result = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-08-01T10:00:00Z',
        serviceIds: [serviceId],
        hasInsurance: false,
        // None of the below are declared schema properties — a scripted,
        // attacker-controlled "model" emitting them anyway.
        amount: 1,
        totalAmount: -99999,
        price: 999999,
        discount: 1,
        currency: 'XXX',
      }),
    );

    expect(result.success).not.toBe(false);
    const appointmentId = result.appointmentId as string;
    const row = await harness.dataSource.query(`SELECT total_amount, currency FROM appointments WHERE id = $1`, [appointmentId]);
    expect(Number(row[0].total_amount)).toBe(SERVICE_PRICE); // exactly the server-side service price — no injected value took effect
    expect(row[0].currency).not.toBe('XXX'); // injected currency also ignored

    await cleanupAppointment(appointmentId);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('the auto-generated PaymentLink amount is the SAME server-derived price, and its status is created ACTIVE — never PAID/VERIFIED by the AI path', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: seed.tenantA.staffUserId, permissions: [PERMISSION.APPOINTMENTS_CREATE] };

    const result = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[0],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-08-02T10:00:00Z',
        serviceIds: [serviceId],
        hasInsurance: false,
        amount: 0.01, // scripted "model" tries to make the link nearly free
        status: 'PAID', // scripted "model" tries to pre-mark it paid
      }),
    );

    expect(result.success).not.toBe(false);
    const appointmentId = result.appointmentId as string;
    expect(result.paymentLink).toBeDefined(); // a link WAS auto-generated (payment_required=true, uninsured, priced)

    const link = await harness.dataSource.query(`SELECT amount, status FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]);
    expect(link).toHaveLength(1);
    expect(Number(link[0].amount)).toBe(SERVICE_PRICE); // never the injected 0.01
    expect(link[0].status).toBe('ACTIVE'); // never "PAID" — the AI path only ever creates an inert link

    await cleanupAppointment(appointmentId);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('an INSURED booking never generates a payment link at all, regardless of injected monetary/status values', async () => {
    const conv = await conversations.start(seed.tenantA.id, {});
    const ctx: ToolContext = { tenantId: seed.tenantA.id, aiConversationId: conv.id, actorUserId: seed.tenantA.staffUserId, permissions: [PERMISSION.APPOINTMENTS_CREATE] };

    const result = await dispatch.execute(
      ctx,
      scriptedToolCall(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: seed.tenantA.branchId,
        customerId: seed.tenantA.customerIds[1],
        staffId: seed.tenantA.staffProfileId,
        startAt: '2027-08-03T10:00:00Z',
        serviceIds: [serviceId],
        hasInsurance: true,
        amount: 999999,
        status: 'PAID',
      }),
    );

    expect(result.success).not.toBe(false);
    expect(result.paymentLink).toBeUndefined();
    const appointmentId = result.appointmentId as string;
    const link = await harness.dataSource.query(`SELECT COUNT(*)::int AS n FROM payment_links WHERE "appointmentId" = $1`, [appointmentId]);
    expect(link[0].n).toBe(0);

    await cleanupAppointment(appointmentId);
    await harness.dataSource.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id]);
  });

  it('structural: no tool in any of the 26 catalogs declares a monetary or payment-status SET argument (amount/totalAmount/price/paymentStatus) — every financial value is server-derived by construction', () => {
    const allSchemas = [...AI_TOOLS, ...AI_ADMIN_TOOLS, ...AI_PUBLIC_BOOKING_TOOLS];
    const forbidden = ['amount', 'totalAmount', 'price', 'paymentStatus', 'paymentAmount', 'discount'];
    const offenders: string[] = [];
    for (const tool of allSchemas) {
      const props = Object.keys(tool.parameters.properties ?? {});
      for (const f of forbidden) {
        if (props.includes(f)) offenders.push(`${tool.name}.${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('structural: AiToolDispatchService injects PaymentLinkService.create only — no payment-VERIFICATION/capture/refund service is reachable from any of the 26 tools', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const dispatchSourcePath = path.join(__dirname, '../../src/modules/ai/tools/ai-tool-dispatch.service.ts');
    const source: string = fs.readFileSync(dispatchSourcePath, 'utf8');
    expect(source).toMatch(/PaymentLinkService/);
    // The verify/capture/refund service is never imported. `PaymentService`
    // as a whole-word check (not merely absent as a substring of
    // `PaymentLinkService`, which DOES legitimately appear).
    expect(source).not.toMatch(/\bPaymentService\b/);
    expect(source).not.toMatch(/\.verify\(|\.capture\(|\.refund\(|\.markPaid\(/);
  });
});
