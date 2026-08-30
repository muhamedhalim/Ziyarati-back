import { AiToolDispatchService } from './ai-tool-dispatch.service';
import { AI_TOOL } from './ai-tools.constants';

/**
 * F-8 / Blocker 2 regression: the SERVER-BOUND customer must always win over
 * a model-supplied `customerId` argument on `book_appointment`.
 *
 * This is the exact gap the WhatsApp customer-binding fix
 * (`AiOrchestratorService`'s `trustedSessionPatch`,
 * `WhatsappInboundAiService`'s `processTurn`) exists to close: WhatsApp is
 * the one channel whose acting principal is authenticated (the tenant's own
 * AI bot actor) yet has no logged-in human to vouch for which patient is
 * texting — `ctx.customerId` (`AiExecutionService.sessionCustomerId`, wired
 * from `session.context.customerId`) is the ONLY thing standing between "the
 * WhatsApp contact who is actually texting" and "whatever customerId the
 * model's tool call happens to contain" (a hallucination, or a
 * prompt-injected one — the AI is untrusted input for authorization, per
 * this file's own class docblock).
 *
 * No pre-existing test in this codebase covered this precedence at all
 * before this change — the scenario "Patient A sends 'احجز لي' and the
 * model attempts to use another customer ID" had zero regression coverage.
 */

const BRANCH_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const START_AT = '2026-09-01T10:00:00+02:00';
const SERVER_BOUND_CUSTOMER_ID = 'patient-a-server-bound';
const MODEL_SUPPLIED_CUSTOMER_ID = 'attacker-or-hallucinated-customer';

function build() {
  const appointments = {
    create: jest.fn().mockResolvedValue({
      id: 'appt-1',
      status: 'CONFIRMED',
      payment_status: 'UNPAID',
      start_at: START_AT,
      end_at: START_AT,
      total_amount: 0,
      currency: 'EGP',
    }),
  };
  const customers = {
    findOneOrThrow: jest.fn().mockResolvedValue({
      id: SERVER_BOUND_CUSTOMER_ID,
      has_health_insurance: null,
    }),
    setInsuranceStatus: jest.fn().mockResolvedValue(undefined),
  };
  const tenants = {
    getSettings: jest.fn().mockResolvedValue({ payment_required: false }),
  };
  const dataSource = {
    query: jest
      .fn()
      .mockImplementation(async (sql: string) =>
        /INSERT INTO ai_tool_calls[\s\S]*RETURNING id/.test(sql)
          ? [{ id: 'claim-1' }]
          : [],
      ),
  };
  const tenantContext = { getCorrelationId: jest.fn().mockReturnValue(null) };

  const service = new AiToolDispatchService(
    appointments as never,
    {} as never, // availability
    {} as never, // discovery
    {} as never, // dashboardMetrics
    {} as never, // subscriptions
    {} as never, // usage
    customers as never,
    {} as never, // staff
    {} as never, // aiAnalytics
    dataSource as never,
    {} as never, // handovers
    tenants as never,
    {} as never, // paymentLinks
    {} as never, // bookingContext
    {} as never, // botActor
    tenantContext as never,
    {} as never, // sessions
    {} as never, // branches
  );
  return { service, appointments };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

describe('book_appointment — server-bound customer wins over a model-supplied one', () => {
  it('books for the SERVER-BOUND customer, ignoring a different customerId the model supplied', async () => {
    const { service, appointments } = build();

    // Simulates a WhatsApp turn: ctx.customerId is populated from the
    // contact's bound Customer (via trustedSessionPatch), while the model's
    // tool call carries a DIFFERENT id — e.g. from a prior message, a
    // hallucination, or a prompt-injection attempt embedded in patient text.
    const ctx = {
      tenantId: 'tenant-a',
      aiConversationId: 'conv-1',
      actorUserId: 'bot-user-1',
      permissions: ['appointments.create'],
      customerId: SERVER_BOUND_CUSTOMER_ID,
    } as never;

    const result: Record<string, unknown> = await service.execute(
      ctx,
      call(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: BRANCH_ID,
        staffId: STAFF_ID,
        startAt: START_AT,
        customerId: MODEL_SUPPLIED_CUSTOMER_ID,
      }),
    );

    expect(result.success).toBe(true);
    expect(appointments.create).toHaveBeenCalledWith(
      'tenant-a',
      'bot-user-1',
      expect.objectContaining({ customerId: SERVER_BOUND_CUSTOMER_ID }),
    );
    // Never even considered — a hallucinated/injected id must not silently
    // fall through, and must not surface anywhere in the executed booking.
    const bookedCustomerId = (
      appointments.create.mock.calls[0]?.[2] as
        | { customerId?: string }
        | undefined
    )?.customerId;
    expect(bookedCustomerId).not.toBe(MODEL_SUPPLIED_CUSTOMER_ID);
  });

  it('falls back to the model-supplied customerId only when nothing is server-bound (e.g. a staff dashboard turn)', async () => {
    const { service, appointments } = build();
    const ctx = {
      tenantId: 'tenant-a',
      aiConversationId: 'conv-1',
      actorUserId: 'staff-user-1',
      permissions: ['appointments.create'],
      // No ctx.customerId — this is the staff/dashboard case, not WhatsApp.
    } as never;

    await service.execute(
      ctx,
      call(AI_TOOL.BOOK_APPOINTMENT, {
        branchId: BRANCH_ID,
        staffId: STAFF_ID,
        startAt: START_AT,
        customerId: MODEL_SUPPLIED_CUSTOMER_ID,
      }),
    );

    expect(appointments.create).toHaveBeenCalledWith(
      'tenant-a',
      'staff-user-1',
      expect.objectContaining({ customerId: MODEL_SUPPLIED_CUSTOMER_ID }),
    );
  });
});
