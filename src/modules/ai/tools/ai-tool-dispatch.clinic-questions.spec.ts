import { AiToolDispatchService } from './ai-tool-dispatch.service';
import { AI_TOOL } from './ai-tools.constants';

/**
 * The reported conversation, at the layer that produced it.
 *
 * A visitor picked a clinic, a branch, a service and a doctor, then asked four
 * ordinary questions — "what are your hours?", "where are you?", "how much is
 * it?", "when is Dr. Halim available?" — and got the same refusal to all of
 * them, because the only tool that could be reached was a SINGLE-DAY
 * availability check that returned a bare empty list. Every test here drives
 * the dispatcher directly: what the model receives is the artefact that decided
 * the answer, and it is produced here.
 *
 * The four properties under test:
 *  1. Each question reaches its OWN tool (§3 of the brief) — an hours question
 *     must never become an availability check.
 *  2. An empty day carries a REASON and real ALTERNATIVES (§4, §5).
 *  3. Slot length comes from the SELECTED SERVICE, server-side (§6).
 *  4. A guest supplies no ids at all — branch and doctor come from the
 *     server-side session, so there is nothing to poison (§12, §17).
 */

const BRANCH = '22222222-2222-4222-8222-222222222222';
const DOCTOR = '33333333-3333-4333-8333-333333333333';
const SERVICE = '44444444-4444-4444-8444-444444444444';
const CLINIC = '55555555-5555-4555-8555-555555555555';

/**
 * An anonymous website visitor: no permissions, no real tenant. `actorUserId`
 * is deliberately set (to the guest's own subject, matching `principal.id`) —
 * Phase 6, production-shape fix. `AiExecutionService` fills `actorUserId` from
 * `getUser().id` on EVERY turn, guests included, so a real guest context always
 * carries a truthy `actorUserId`; a fixture that left it unset was exactly the
 * shape that hid F-01 (only `!ctx.actorUserId` was checked, never
 * `principal.guest`), so it never proved `isGuest()`'s `principal.guest ===
 * true` branch actually does the work.
 */
const GUEST_CTX = {
  tenantId: 'guest-discovery-tenant',
  aiConversationId: 'conv-1',
  actorUserId: 'guest-sub',
  principal: { id: 'guest-sub', guest: true, permissions: [] },
} as never;

/** An authenticated WhatsApp/staff turn: acts as its own clinic. */
const STAFF_CTX = {
  tenantId: CLINIC,
  actorUserId: 'bot-actor',
  aiConversationId: 'conv-2',
  permissions: [],
} as never;

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

function build(
  discovery: Record<string, unknown>,
  opts: {
    availability?: Record<string, unknown>;
    /** What the server-side booking session has recorded. */
    booking?: Record<string, unknown> | Error;
    branchTimezone?: string;
  } = {},
) {
  const requireContext = jest.fn().mockImplementation(async () => {
    if (opts.booking instanceof Error) throw opts.booking;
    return (
      opts.booking ?? {
        tenantId: CLINIC,
        branchId: BRANCH,
        staffId: DOCTOR,
        serviceIds: [SERVICE],
        aiConversationId: 'conv-1',
      }
    );
  });

  const dataSource = {
    query: jest.fn().mockImplementation(async (sql: string) => {
      if (/INSERT INTO ai_tool_calls[\s\S]*RETURNING id/.test(sql)) {
        return [{ id: 'claim-1' }];
      }
      if (/SELECT timezone FROM branches/.test(sql)) {
        return [{ timezone: opts.branchTimezone ?? 'Asia/Riyadh' }];
      }
      return [];
    }),
  };

  const service = new AiToolDispatchService(
    {} as never, // appointments
    (opts.availability ?? {}) as never,
    discovery as never,
    {} as never, // dashboardMetrics
    {} as never, // subscriptions
    {} as never, // usage
    {} as never, // customers
    {} as never, // staff
    {} as never, // aiAnalytics
    dataSource as never,
    {} as never, // handovers
    {} as never, // tenants
    {} as never, // paymentLinks
    { requireContext, patchSelection: jest.fn() } as never, // bookingContext
    {} as never, // botActor
    { getCorrelationId: () => null } as never,
    {} as never, // sessions
    {} as never, // branches
  );
  return { service, requireContext, dataSource };
}

/** One bookable day, 10:00–11:30 Riyadh (07:00–08:30Z), in 45-minute slots. */
const BOOKABLE_DAY = {
  date: '2026-09-02',
  branchId: BRANCH,
  staffId: DOCTOR,
  timezone: 'Asia/Riyadh',
  available: true,
  windows: [
    {
      startTime: '2026-09-02T07:00:00.000Z',
      endTime: '2026-09-02T07:45:00.000Z',
    },
    {
      startTime: '2026-09-02T07:45:00.000Z',
      endTime: '2026-09-02T08:30:00.000Z',
    },
  ],
};

const EMPTY_DAY = (date: string, reason: string) => ({
  date,
  branchId: BRANCH,
  staffId: DOCTOR,
  timezone: 'Asia/Riyadh',
  available: false,
  reason,
  windows: [],
});

// ───────────────────── §3 / §9 / §10: "what are your hours? where are you?" ──

describe('get_branch_info — the hours and location question', () => {
  const INFO = {
    branch: {
      id: BRANCH,
      name: 'Main Branch',
      address: 'شارع التحلية، جدة',
      city: 'جدة',
      phone: '+966500000000',
      whatsapp: null,
      timezone: 'Asia/Riyadh',
    },
    clinic: { id: CLINIC, name: 'noor' },
    workingHours: [
      {
        dayOfWeek: 0,
        day: 'Sunday',
        status: 'OPEN',
        hours: [{ start: '10:00', end: '20:00' }],
      },
      { dayOfWeek: 5, day: 'Friday', status: 'CLOSED', hours: [] },
      { dayOfWeek: 6, day: 'Saturday', status: 'NOT_PUBLISHED', hours: [] },
    ],
    workingHoursConfigured: true,
  };

  it('returns the real working hours and address from the database', async () => {
    const branchInfo = jest.fn().mockResolvedValue(INFO);
    const { service } = build({ branchInfo });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.GET_BRANCH_INFO),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(true);
    expect((res.branch as Record<string, unknown>).address).toBe(
      'شارع التحلية، جدة',
    );
    expect(res.workingHours).toHaveLength(3);
  });

  it('takes NO ids from a guest — the branch comes from the server session', async () => {
    const branchInfo = jest.fn().mockResolvedValue(INFO);
    const { service, requireContext } = build({ branchInfo });

    // The model even TRIES to name another clinic's branch; it is ignored.
    await service.execute(
      GUEST_CTX,
      call(AI_TOOL.GET_BRANCH_INFO, {
        branchId: '99999999-9999-4999-8999-999999999999',
      }),
    );

    expect(requireContext).toHaveBeenCalled();
    expect(branchInfo).toHaveBeenCalledWith(BRANCH, { tenantId: undefined });
  });

  it('scopes an AUTHENTICATED turn to its own tenant', async () => {
    const branchInfo = jest.fn().mockResolvedValue(INFO);
    const { service } = build({ branchInfo });

    await service.execute(
      STAFF_CTX,
      call(AI_TOOL.GET_BRANCH_INFO, { branchId: BRANCH }),
    );

    expect(branchInfo).toHaveBeenCalledWith(BRANCH, { tenantId: CLINIC });
  });

  it('distinguishes "not published" from "closed" instead of inventing hours', async () => {
    const { service } = build({
      branchInfo: jest.fn().mockResolvedValue({
        ...INFO,
        workingHours: [],
        workingHoursConfigured: false,
      }),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.GET_BRANCH_INFO),
    )) as never as Record<string, unknown>;

    expect(res.guidance).toContain('NOT published any working hours');
    expect(res.guidance).toContain('Never invent hours');
  });
});

// ───────────────────────────── §3: "when does Dr. X work?" ──────────────────

describe('get_doctor_schedule — the working-days question', () => {
  const SCHEDULE = {
    doctor: { id: DOCTOR, name: 'د. خالد العتيبي', title: null },
    weekly: [
      {
        dayOfWeek: 1,
        day: 'Monday',
        hours: [{ start: '10:00', end: '20:00' }],
      },
    ],
    worksAtBranch: true,
    note: 'roster, not free time',
  };

  it('answers with the recurring roster, not an availability check', async () => {
    const doctorSchedule = jest.fn().mockResolvedValue(SCHEDULE);
    const { service } = build({ doctorSchedule });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.GET_DOCTOR_SCHEDULE),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(true);
    expect(res.weekly).toHaveLength(1);
    // Says explicitly that a rostered day can still be full — the distinction
    // between SCHEDULE and AVAILABILITY the brief asks for (§6).
    expect(res.guidance).toContain('fully booked');
    // Resolved from the session, scoped to the session's clinic.
    expect(doctorSchedule).toHaveBeenCalledWith(CLINIC, BRANCH, DOCTOR);
  });

  it('does not present an unrostered doctor as a temporary shortage', async () => {
    const { service } = build({
      doctorSchedule: jest.fn().mockResolvedValue({ ...SCHEDULE, weekly: [] }),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.GET_DOCTOR_SCHEDULE),
    )) as never as Record<string, unknown>;

    expect(res.guidance).toContain('no working days configured');
  });
});

// ──────────────── §4 / §5: availability always offers something next ────────

describe('search_public_availability — never a dead end', () => {
  it('sizes slots from the SELECTED SERVICE, not from the model', async () => {
    const publicRangeAvailability = jest
      .fn()
      .mockResolvedValue({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] });
    const { service } = build({
      publicRangeAvailability,
      // A 45-minute service is on the session.
      listBranchServices: jest
        .fn()
        .mockResolvedValue([{ id: SERVICE, durationMinutes: 45, price: 250 }]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: '2026-09-02' }),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(true);
    expect(res.appointmentMinutes).toBe(45);
    expect(publicRangeAvailability).toHaveBeenCalledWith(
      BRANCH,
      DOCTOR,
      expect.objectContaining({ slotMinutes: 45 }),
    );
  });

  it('renders each slot in the BRANCH timezone, not UTC', async () => {
    const { service } = build({
      publicRangeAvailability: jest
        .fn()
        .mockResolvedValue({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] }),
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: '2026-09-02' }),
    )) as never as Record<string, unknown>;

    const days = res.days as { date: string; slots: { localTime: string }[] }[];
    // 07:00Z is 10:00 in Asia/Riyadh — what the patient is actually told.
    expect(days[0].slots.map((s) => s.localTime)).toEqual(['10:00', '10:45']);
  });

  it('keeps looking when the requested day is empty, and returns real alternatives', async () => {
    const publicRangeAvailability = jest
      .fn()
      // Pass 1 — the day the visitor asked about.
      .mockResolvedValueOnce({
        timezone: 'Asia/Riyadh',
        days: [EMPTY_DAY('2026-09-01', 'not_working_that_day')],
      })
      // Pass 2 — the automatic forward search.
      .mockResolvedValueOnce({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] });

    const { service } = build({
      publicRangeAvailability,
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: '2026-09-01' }),
    )) as never as Record<string, unknown>;

    // The reason the asked-for day failed, in words the model can relay...
    expect(res.requestedDayReason).toBe('not_working_that_day');
    expect(res.requestedDayExplanation).toBe(
      'The doctor is not rostered to work that day.',
    );
    // ...and real times to offer instead, which is what was missing.
    const next = res.nextAvailable as { date: string; slots: unknown[] }[];
    expect(next).toHaveLength(1);
    expect(next[0].date).toBe('2026-09-02');
    expect(next[0].slots).toHaveLength(2);
    expect(res.guidance).toContain('Do NOT stop at "unavailable"');
    expect(publicRangeAvailability).toHaveBeenCalledTimes(2);
  });

  it('costs exactly one search when the requested day works', async () => {
    const publicRangeAvailability = jest
      .fn()
      .mockResolvedValue({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] });
    const { service } = build({
      publicRangeAvailability,
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: '2026-09-02' }),
    );

    // No speculative forward scan when there was nothing to recover from.
    expect(publicRangeAvailability).toHaveBeenCalledTimes(1);
  });

  it('answers the open-ended "when is the doctor free?" with no date at all', async () => {
    const publicRangeAvailability = jest
      .fn()
      .mockResolvedValue({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] });
    const { service } = build({
      publicRangeAvailability,
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(true);
    expect(res.requestedDate).toBeUndefined();
    // Open-ended searches collect several days rather than one.
    expect(publicRangeAvailability).toHaveBeenCalledWith(
      BRANCH,
      DOCTOR,
      expect.objectContaining({ maxDaysWithSlots: 3 }),
    );
  });

  it('says so plainly — once — when the whole window really is empty', async () => {
    const { service } = build({
      publicRangeAvailability: jest.fn().mockResolvedValue({
        timezone: 'Asia/Riyadh',
        days: [EMPTY_DAY('2026-09-01', 'fully_booked')],
      }),
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: '2026-09-01' }),
    )) as never as Record<string, unknown>;

    expect(res.slotCount).toBe(0);
    expect(res.requestedDayExplanation).toContain(
      'every slot is already taken',
    );
    expect(res.guidance).toContain('do not repeat the same refusal');
  });

  it('rejects a malformed date instead of silently searching the wrong day', async () => {
    const { service } = build({
      publicRangeAvailability: jest.fn(),
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, { date: 'next Tuesday' }),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(false);
    expect(res.error).toContain('YYYY-MM-DD');
  });

  it('caps daysAhead at the anonymous horizon however large the model asks for', async () => {
    const publicRangeAvailability = jest.fn().mockResolvedValue({
      timezone: 'Asia/Riyadh',
      days: [EMPTY_DAY('2026-09-01', 'fully_booked')],
    });
    const { service } = build({
      publicRangeAvailability,
      listBranchServices: jest.fn().mockResolvedValue([]),
    });

    await service.execute(
      GUEST_CTX,
      call(AI_TOOL.SEARCH_PUBLIC_AVAILABILITY, {
        date: '2026-09-01',
        daysAhead: 3650,
      }),
    );

    const forwardSearch = publicRangeAvailability.mock.calls[1][2];
    // 2026-09-02 .. 2026-09-15 — 14 days, the pre-existing abuse control.
    expect(forwardSearch.toDate).toBe('2026-09-15');
  });
});

// ───────────────────── §3 / §15: the same contract on WhatsApp/staff ────────

describe('check_availability — the authenticated channel gets the same contract', () => {
  it('offers alternatives rather than a dead end', async () => {
    const rangeWindows = jest
      .fn()
      .mockResolvedValueOnce({
        timezone: 'Asia/Riyadh',
        days: [EMPTY_DAY('2026-09-01', 'holiday')],
      })
      .mockResolvedValueOnce({ timezone: 'Asia/Riyadh', days: [BOOKABLE_DAY] });

    const { service } = build({}, { availability: { rangeWindows } });

    const res = (await service.execute(
      STAFF_CTX,
      call(AI_TOOL.CHECK_AVAILABILITY, {
        branchId: BRANCH,
        staffId: DOCTOR,
        date: '2026-09-01',
        slotMinutes: 45,
      }),
    )) as never as Record<string, unknown>;

    expect(res.requestedDayExplanation).toContain(
      'closed that day for a holiday',
    );
    expect((res.nextAvailable as unknown[]).length).toBe(1);
    // Tenant comes from the context, never from the model.
    expect(rangeWindows).toHaveBeenCalledWith(CLINIC, expect.any(Object));
  });

  it('still refuses without a branch and staff id', async () => {
    const { service } = build(
      {},
      { availability: { rangeWindows: jest.fn() } },
    );

    const res = (await service.execute(
      STAFF_CTX,
      call(AI_TOOL.CHECK_AVAILABILITY, { date: '2026-09-01' }),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(false);
  });

  it('is still closed to an anonymous turn', async () => {
    const { service } = build(
      {},
      { availability: { rangeWindows: jest.fn() } },
    );

    const res = (await service.execute(
      GUEST_CTX,
      call(AI_TOOL.CHECK_AVAILABILITY, { branchId: BRANCH, staffId: DOCTOR }),
    )) as never as Record<string, unknown>;

    expect(res.success).toBe(false);
    expect(res.error).toContain('not available in this context');
  });
});

// ─────────────────────────────── §10: the price question ────────────────────

describe('list_branch_services — an unpublished price is not "free"', () => {
  it('labels a null price NOT_PUBLISHED and says never to call it free', async () => {
    const { service } = build({
      listBranchServices: jest.fn().mockResolvedValue([
        { id: SERVICE, name: 'تنظيف أسنان', durationMinutes: 45, price: null },
        { id: 'svc-2', name: 'Consultation', durationMinutes: 30, price: 0 },
        { id: 'svc-3', name: 'Whitening', durationMinutes: 60, price: 250 },
      ]),
    });

    const res = (await service.execute(
      GUEST_CTX,
      call('list_branch_services'),
    )) as never as Record<string, unknown>;

    const services = res.services as { priceStatus: string }[];
    expect(services.map((s) => s.priceStatus)).toEqual([
      'NOT_PUBLISHED',
      'PUBLISHED', // an explicit 0 IS free, and stays distinguishable
      'PUBLISHED',
    ]);
    expect(res.guidance).toContain('NEVER call it free');
    expect(res.guidance).toContain('Only price 0 is free');
  });
});
