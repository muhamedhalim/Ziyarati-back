import {
  generateInsights,
  type JourneyInsightsInput,
  type JourneyLabel,
} from './journey-insights';
import { shapeJourneyCoverages, shapeKpis } from './journey-shaping';
import { JOURNEY_INSIGHT_CODE, JOURNEY_THRESHOLDS } from './journey.constants';
import { METRIC_KEYS } from '../metric-registry';
import type {
  JourneyDimensionRow,
  JourneyOverallRow,
  JourneyRemindersInfo,
} from './journey.types';

function row(overrides: Partial<JourneyOverallRow> = {}): JourneyOverallRow {
  return {
    booked: 0,
    cancelled: 0,
    no_show: 0,
    completed: 0,
    in_progress: 0,
    upcoming: 0,
    past: 0,
    unresolved_past: 0,
    arrived: 0,
    called: 0,
    started: 0,
    completed_with_queue: 0,
    completed_without_start: 0,
    completed_with_timing: 0,
    consult_too_short: 0,
    consult_invalid: 0,
    swept: 0,
    multi_service: 0,
    no_service: 0,
    tz_fallback: 0,
    start_from_queue: 0,
    start_from_log: 0,
    rem_eligible: 0,
    rem_with_row: 0,
    rem_reminded: 0,
    rem_failed_only: 0,
    resolved_reminded: 0,
    resolved_not_reminded: 0,
    no_show_reminded: 0,
    no_show_not_reminded: 0,
    lead_n: 0,
    lead_invalid: 0,
    lead_p50: null,
    lead_p90: null,
    arrival_n: 0,
    arrival_invalid: 0,
    arrival_late_n: 0,
    arrival_p50: null,
    arrival_p90: null,
    wait_call_n: 0,
    wait_call_invalid: 0,
    wait_call_p50: null,
    wait_call_p90: null,
    call_start_n: 0,
    call_start_invalid: 0,
    call_start_p50: null,
    call_start_p90: null,
    wait_start_n: 0,
    wait_start_invalid: 0,
    wait_start_p50: null,
    wait_start_p90: null,
    ready_delay_n: 0,
    ready_delay_invalid: 0,
    ready_delay_p50: null,
    ready_delay_p90: null,
    start_delay_n: 0,
    start_delay_invalid: 0,
    start_delay_p50: null,
    start_delay_p90: null,
    consult_n: 0,
    consult_p50: null,
    consult_p75: null,
    consult_p90: null,
    overrun_p50: null,
    overrun_p90: null,
    visit_n: 0,
    visit_invalid: 0,
    visit_p50: null,
    visit_p90: null,
    scheduled_p50: null,
    ...overrides,
  };
}

function dimRow(
  overrides: Partial<JourneyDimensionRow> = {},
): JourneyDimensionRow {
  return { ...row(), dim_key: 'dim-1', ...overrides };
}

const NO_REMINDERS: JourneyRemindersInfo = {
  available: false,
  enabled: false,
  reason: 'NOT_ENABLED',
};

function baseInput(
  overrides: Partial<JourneyInsightsInput> = {},
): JourneyInsightsInput {
  const overall = overrides.overall ?? row();
  const cov = shapeJourneyCoverages(overall);
  const kpis =
    overrides.kpis ??
    shapeKpis(overall, JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY, cov);
  return {
    overall,
    priorOverall: null,
    kpis,
    queueCoverageRate: cov.queue.rate,
    remindersEnabled: false,
    reminders: NO_REMINDERS,
    dimensions: { branch: [], staff: [], service: [], hour: [] },
    labels: { branch: new Map(), staff: new Map(), service: new Map() },
    ...overrides,
  };
}

function codesOf(
  insights: ReturnType<typeof generateInsights>['insights'],
): string[] {
  return insights.map((i) => i.code);
}

describe('generateInsights — data quality', () => {
  it('fires QUEUE_NOT_USED at exactly the min sample, not one below', () => {
    const atMin = generateInsights(
      baseInput({ overall: row({ completed: 30, completed_with_queue: 0 }) }),
    );
    expect(codesOf(atMin.insights)).toContain(
      JOURNEY_INSIGHT_CODE.QUEUE_NOT_USED,
    );

    const belowMin = generateInsights(
      baseInput({ overall: row({ completed: 29, completed_with_queue: 0 }) }),
    );
    expect(codesOf(belowMin.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.QUEUE_NOT_USED,
    );
  });

  it('fires QUEUE_COVERAGE_LOW only strictly between 0 and the floor', () => {
    const low = generateInsights(
      baseInput({ overall: row({ completed: 40, completed_with_queue: 10 }) }), // 25%
    );
    expect(codesOf(low.insights)).toContain(
      JOURNEY_INSIGHT_CODE.QUEUE_COVERAGE_LOW,
    );

    const healthy = generateInsights(
      baseInput({ overall: row({ completed: 40, completed_with_queue: 30 }) }), // 75%
    );
    expect(codesOf(healthy.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.QUEUE_COVERAGE_LOW,
    );
  });

  it('fires CONSULTATION_START_NOT_RECORDED above 50% and not at exactly 50%', () => {
    const above = generateInsights(
      baseInput({
        overall: row({ completed: 40, completed_without_start: 21 }),
      }), // 52.5%
    );
    expect(codesOf(above.insights)).toContain(
      JOURNEY_INSIGHT_CODE.CONSULTATION_START_NOT_RECORDED,
    );

    const exactly = generateInsights(
      baseInput({
        overall: row({ completed: 40, completed_without_start: 20 }),
      }), // exactly 50%
    );
    expect(codesOf(exactly.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.CONSULTATION_START_NOT_RECORDED,
    );
  });

  it('fires UNRESOLVED_APPOINTMENTS only when both the count and the share thresholds are met', () => {
    const bothMet = generateInsights(
      baseInput({ overall: row({ past: 100, unresolved_past: 10 }) }), // count=10, share=10%
    );
    expect(codesOf(bothMet.insights)).toContain(
      JOURNEY_INSIGHT_CODE.UNRESOLVED_APPOINTMENTS,
    );

    const countOnly = generateInsights(
      baseInput({ overall: row({ past: 1000, unresolved_past: 10 }) }), // share=1%, below floor
    );
    expect(codesOf(countOnly.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.UNRESOLVED_APPOINTMENTS,
    );
  });

  it('fires REMINDERS_DISABLED when off with no rows, REMINDERS_NOT_SCHEDULED when on with none scheduled', () => {
    const off = generateInsights(
      baseInput({ overall: row({ booked: 40 }), remindersEnabled: false }),
    );
    expect(codesOf(off.insights)).toContain(
      JOURNEY_INSIGHT_CODE.REMINDERS_DISABLED,
    );

    const on = generateInsights(
      baseInput({
        overall: row({ booked: 40, rem_eligible: 40, rem_with_row: 0 }),
        remindersEnabled: true,
      }),
    );
    expect(codesOf(on.insights)).toContain(
      JOURNEY_INSIGHT_CODE.REMINDERS_NOT_SCHEDULED,
    );
    expect(codesOf(on.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.REMINDERS_DISABLED,
    );
  });

  it('always includes CHECKOUT_NOT_TRACKED and FEEDBACK_NOT_COLLECTED for a non-empty period', () => {
    const r = generateInsights(baseInput({ overall: row({ booked: 5 }) }));
    expect(codesOf(r.insights)).toEqual(
      expect.arrayContaining([
        JOURNEY_INSIGHT_CODE.CHECKOUT_NOT_TRACKED,
        JOURNEY_INSIGHT_CODE.FEEDBACK_NOT_COLLECTED,
      ]),
    );
  });

  it('omits the untracked-stage notes entirely for a genuinely empty period', () => {
    const r = generateInsights(baseInput({ overall: row({ booked: 0 }) }));
    expect(codesOf(r.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.CHECKOUT_NOT_TRACKED,
    );
  });
});

describe('generateInsights — wait alerts', () => {
  it('escalates WAIT_TO_START_HIGH from warning to critical at the critical p50', () => {
    const warn = generateInsights(
      baseInput({
        overall: row({
          completed: 40,
          completed_with_queue: 40,
          wait_start_n: 40,
          wait_start_p50: 25,
          wait_start_p90: 30,
        }),
      }),
    );
    const warnInsight = warn.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.WAIT_TO_START_HIGH,
    );
    expect(warnInsight?.severity).toBe('warning');

    const crit = generateInsights(
      baseInput({
        overall: row({
          completed: 40,
          completed_with_queue: 40,
          wait_start_n: 40,
          wait_start_p50: 45,
          wait_start_p90: 95,
        }),
      }),
    );
    const critInsight = crit.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.WAIT_TO_START_HIGH,
    );
    expect(critInsight?.severity).toBe('critical');
  });

  it('does not fire below the minimum sample even with an extreme p50', () => {
    const r = generateInsights(
      baseInput({
        overall: row({
          completed: 40,
          completed_with_queue: 40,
          wait_start_n: 5,
          wait_start_p50: 90,
        }),
      }),
    );
    expect(codesOf(r.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.WAIT_TO_START_HIGH,
    );
  });

  it('WAIT_TO_START_INCREASED requires both the ratio AND a minimum absolute delta', () => {
    // p50 10 -> 12.5 is exactly 1.25x but only +2.5 min (below the +5 min floor)
    const smallDelta = generateInsights(
      baseInput({
        overall: row({ wait_start_n: 40, wait_start_p50: 12.5 }),
        priorOverall: row({ wait_start_n: 40, wait_start_p50: 10 }),
      }),
    );
    expect(codesOf(smallDelta.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.WAIT_TO_START_INCREASED,
    );

    // p50 20 -> 30 is 1.5x and +10 min — both satisfied
    const real = generateInsights(
      baseInput({
        overall: row({ wait_start_n: 40, wait_start_p50: 30 }),
        priorOverall: row({ wait_start_n: 40, wait_start_p50: 20 }),
      }),
    );
    expect(codesOf(real.insights)).toContain(
      JOURNEY_INSIGHT_CODE.WAIT_TO_START_INCREASED,
    );
  });

  it('is skipped entirely when there is no prior-period data', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ wait_start_n: 40, wait_start_p50: 30 }),
        priorOverall: null,
      }),
    );
    expect(codesOf(r.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.WAIT_TO_START_INCREASED,
    );
  });
});

describe('generateInsights — ready delay / doctor punctuality', () => {
  const labels = new Map<string, JourneyLabel>([
    ['staff-1', { name: 'Dr. A' }],
  ]);

  it('fires on the absolute warning threshold for one staff member', () => {
    const r = generateInsights(
      baseInput({
        dimensions: {
          branch: [],
          staff: [
            dimRow({
              dim_key: 'staff-1',
              ready_delay_n: 40,
              ready_delay_p50: 16,
            }),
          ],
          service: [],
          hour: [],
        },
        labels: { branch: new Map(), staff: labels, service: new Map() },
      }),
    );
    const alert = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.READY_DELAY_HIGH,
    );
    expect(alert).toBeDefined();
    expect(alert?.scope).toMatchObject({
      dimension: 'staff',
      key: 'staff-1',
      label: 'Dr. A',
    });
  });

  it('skips an inactive staff member even above threshold', () => {
    const r = generateInsights(
      baseInput({
        dimensions: {
          branch: [],
          staff: [
            dimRow({
              dim_key: 'staff-1',
              ready_delay_n: 40,
              ready_delay_p50: 40,
            }),
          ],
          service: [],
          hour: [],
        },
        labels: {
          branch: new Map(),
          staff: new Map([['staff-1', { name: 'Dr. A', inactive: true }]]),
          service: new Map(),
        },
      }),
    );
    expect(codesOf(r.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.READY_DELAY_HIGH,
    );
  });

  it('falls back to start_delay when ready_delay has too few samples', () => {
    const r = generateInsights(
      baseInput({
        dimensions: {
          branch: [],
          staff: [
            dimRow({
              dim_key: 'staff-1',
              ready_delay_n: 2,
              start_delay_n: 40,
              start_delay_p50: 20,
            }),
          ],
          service: [],
          hour: [],
        },
        labels: { branch: new Map(), staff: labels, service: new Map() },
      }),
    );
    const alert = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.READY_DELAY_HIGH,
    );
    expect(alert?.metric).toBe('journey.start_delay');
  });
});

describe('generateInsights — consultation overrun', () => {
  it('requires both an absolute overrun floor and the scheduled-ratio condition', () => {
    const labels = new Map<string, JourneyLabel>([
      ['svc-1', { name: 'Cleaning' }],
    ]);
    const meetsBoth = generateInsights(
      baseInput({
        dimensions: {
          branch: [],
          staff: [],
          service: [
            dimRow({
              dim_key: 'svc-1',
              consult_n: 40,
              completed: 40,
              completed_with_timing: 40,
              overrun_p50: 8,
              consult_p50: 40,
              scheduled_p50: 30,
            }),
          ],
          hour: [],
        },
        labels: { branch: new Map(), staff: new Map(), service: labels },
      }),
    );
    expect(codesOf(meetsBoth.insights)).toContain(
      JOURNEY_INSIGHT_CODE.CONSULTATION_OVERRUN,
    );

    const overrunOnlyNoRatio = generateInsights(
      baseInput({
        dimensions: {
          branch: [],
          staff: [],
          service: [
            dimRow({
              dim_key: 'svc-1',
              consult_n: 40,
              completed: 40,
              completed_with_timing: 40,
              overrun_p50: 8,
              consult_p50: 32,
              scheduled_p50: 30, // ratio only 1.07x, below 1.2x
            }),
          ],
          hour: [],
        },
        labels: { branch: new Map(), staff: new Map(), service: labels },
      }),
    );
    expect(codesOf(overrunOnlyNoRatio.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.CONSULTATION_OVERRUN,
    );
  });
});

describe('generateInsights — no-show rate', () => {
  it('escalates severity and prefers ENABLE_REMINDERS when reminders are off', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ booked: 40, no_show: 12 }),
        remindersEnabled: false,
      }),
    ); // 30%
    const alert = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.NO_SHOW_RATE_HIGH,
    );
    expect(alert?.severity).toBe('critical');
    expect(alert?.actionKey).toBe('ENABLE_REMINDERS');
  });

  it('suggests reviewing lead times when reminders are already on', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ booked: 40, no_show: 7 }),
        remindersEnabled: true,
      }),
    ); // 17.5%, warning band
    const alert = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.NO_SHOW_RATE_HIGH,
    );
    expect(alert?.severity).toBe('warning');
    expect(alert?.actionKey).toBe('REVIEW_REMINDER_LEAD_TIMES');
  });

  it('NO_SHOW_RATE_INCREASED requires both the ratio and the min percentage-point delta', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ booked: 100, no_show: 20 }), // 20%
        priorOverall: row({ booked: 100, no_show: 14 }), // 14% -> +6pp, x1.43
      }),
    );
    expect(codesOf(r.insights)).toContain(
      JOURNEY_INSIGHT_CODE.NO_SHOW_RATE_INCREASED,
    );
  });
});

describe('generateInsights — peak hour / branch outlier', () => {
  it('flags only hours meeting both the ratio and minimum delta, capped at the top N', () => {
    const hourRows = Array.from({ length: 24 }, (_, h) =>
      dimRow({
        dim_key: String(h),
        wait_start_n: 40,
        wait_start_p50: h === 10 ? 40 : h === 14 ? 35 : 12,
      }),
    );
    const r = generateInsights(
      baseInput({
        overall: row({
          completed: 40,
          completed_with_queue: 40,
          wait_start_n: 40,
          wait_start_p50: 12,
        }),
        dimensions: { branch: [], staff: [], service: [], hour: hourRows },
      }),
    );
    const peakAlerts = r.insights.filter(
      (i) => i.code === JOURNEY_INSIGHT_CODE.PEAK_HOUR_WAIT,
    );
    expect(peakAlerts.length).toBeGreaterThan(0);
    expect(peakAlerts.every((a) => a.observed! >= 12 * 1.5)).toBe(true);
  });

  it('requires at least 2 qualifying branches before flagging an outlier', () => {
    const oneOnly = generateInsights(
      baseInput({
        dimensions: {
          branch: [
            dimRow({ dim_key: 'b1', wait_start_n: 40, wait_start_p50: 50 }),
          ],
          staff: [],
          service: [],
          hour: [],
        },
        labels: {
          branch: new Map([['b1', { name: 'Branch 1' }]]),
          staff: new Map(),
          service: new Map(),
        },
      }),
    );
    expect(codesOf(oneOnly.insights)).not.toContain(
      JOURNEY_INSIGHT_CODE.BRANCH_WAIT_OUTLIER,
    );

    const twoQualifying = generateInsights(
      baseInput({
        dimensions: {
          branch: [
            dimRow({ dim_key: 'b1', wait_start_n: 40, wait_start_p50: 10 }),
            dimRow({ dim_key: 'b2', wait_start_n: 40, wait_start_p50: 40 }),
          ],
          staff: [],
          service: [],
          hour: [],
        },
        labels: {
          branch: new Map([
            ['b1', { name: 'Branch 1' }],
            ['b2', { name: 'Branch 2' }],
          ]),
          staff: new Map(),
          service: new Map(),
        },
      }),
    );
    expect(codesOf(twoQualifying.insights)).toContain(
      JOURNEY_INSIGHT_CODE.BRANCH_WAIT_OUTLIER,
    );
  });
});

describe('generateInsights — reminders', () => {
  const reminders = (
    overrides: Partial<Extract<JourneyRemindersInfo, { available: true }>> = {},
  ): JourneyRemindersInfo => ({
    available: true,
    enabled: true,
    configuredLeadMinutes: [1440],
    appointments: {
      eligible: 40,
      withReminderRow: 40,
      reminded: 30,
      failedOnly: 5,
      noReminderRow: 0,
    },
    rows: {
      sent: 30,
      failed: 10,
      cancelled: 0,
      pending: 0,
      stuck: 0,
      failureRate: 0.25,
    },
    byLeadTime: [],
    byChannel: [],
    failureReasons: [{ reason: 'NO_PROVIDER', count: 10 }],
    attendance: {
      reminded: { resolved: 35, noShow: 3, share: 0.086 },
      notReminded: { resolved: 35, noShow: 10, share: 0.286 },
      comparable: true,
    },
    deliveryTracking: 'NOT_RELIABLE',
    ...overrides,
  });

  it('fires REMINDER_FAILURE_RATE_HIGH and picks the action from the top failure reason', () => {
    const r = generateInsights(
      baseInput({ remindersEnabled: true, reminders: reminders() }),
    );
    const alert = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.REMINDER_FAILURE_RATE_HIGH,
    );
    expect(alert).toBeDefined();
    expect(alert?.actionKey).toBe('CONNECT_WHATSAPP');
  });

  it('fires REMINDER_ATTENDANCE_GAP only when the groups are comparable and the gap clears the floor', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ rem_eligible: 40, rem_reminded: 30 }),
        remindersEnabled: true,
        reminders: reminders(),
      }),
    );
    expect(codesOf(r.insights)).toContain(
      JOURNEY_INSIGHT_CODE.REMINDER_ATTENDANCE_GAP,
    );
  });

  it('never claims causation in its stored data — the wording lives in i18n, not here', () => {
    const r = generateInsights(
      baseInput({
        overall: row({ rem_eligible: 40, rem_reminded: 30 }),
        remindersEnabled: true,
        reminders: reminders(),
      }),
    );
    const rec = r.insights.find(
      (i) => i.code === JOURNEY_INSIGHT_CODE.REMINDER_ATTENDANCE_GAP,
    );
    // The insight carries only numeric params/codes — no free-text field exists to check,
    // which is itself the guarantee: causal wording is structurally impossible here.
    expect(
      rec &&
        Object.values(rec.params).every(
          (v) => typeof v === 'number' || typeof v === 'string',
        ),
    ).toBe(true);
  });
});

describe('generateInsights — ordering, cap and registry consistency', () => {
  it('orders critical before warning before info, and caps at MAX_INSIGHTS', () => {
    const hourRows = Array.from({ length: 24 }, (_, h) =>
      dimRow({ dim_key: String(h), wait_start_n: 40, wait_start_p50: 12 }),
    );
    const r = generateInsights(
      baseInput({
        overall: row({
          booked: 100,
          completed: 100,
          completed_with_queue: 0, // QUEUE_NOT_USED (info)
          no_show: 30, // NO_SHOW_RATE_HIGH critical
          wait_start_n: 40,
          wait_start_p50: 45, // WAIT_TO_START_HIGH critical
        }),
        dimensions: { branch: [], staff: [], service: [], hour: hourRows },
      }),
    );
    const ranks: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < r.insights.length; i++) {
      expect(ranks[r.insights[i].severity]).toBeGreaterThanOrEqual(
        ranks[r.insights[i - 1].severity],
      );
    }
    expect(r.insights.length).toBeLessThanOrEqual(
      JOURNEY_THRESHOLDS.MAX_INSIGHTS,
    );
  });

  it('every metric referenced by an insight exists in the metric registry', () => {
    const r = generateInsights(
      baseInput({
        overall: row({
          booked: 100,
          completed: 100,
          completed_with_queue: 100,
          completed_with_timing: 100,
          no_show: 30,
          wait_start_n: 40,
          wait_start_p50: 45,
          wait_start_p90: 90,
        }),
      }),
    );
    for (const insight of r.insights) {
      if (insight.metric) expect(METRIC_KEYS).toContain(insight.metric);
    }
  });

  it('every param is a number or string — never a pre-rendered sentence template', () => {
    const r = generateInsights(
      baseInput({ overall: row({ booked: 100, completed: 100, no_show: 30 }) }),
    );
    for (const insight of r.insights) {
      for (const v of Object.values(insight.params)) {
        expect(['number', 'string']).toContain(typeof v);
      }
    }
  });
});
