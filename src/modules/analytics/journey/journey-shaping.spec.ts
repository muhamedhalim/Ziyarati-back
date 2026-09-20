import {
  round1,
  round3,
  shapeComparison,
  shapeCounts,
  shapeDataQuality,
  shapeDistribution,
  shapeDurationExplanation,
  shapeDurationSuggestions,
  shapeJourneyCoverages,
  shapeKpis,
  shapeReminders,
  shapeStages,
  suggestDurationMinutes,
  suppressionFor,
} from './journey-shaping';
import { JOURNEY_THRESHOLDS } from './journey.constants';
import type {
  JourneyDimensionRow,
  JourneyOverallRow,
  JourneyReminderRow,
} from './journey.types';

/** A fully-zeroed row — every test overrides only the fields it cares about. */
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

describe('round1 / round3', () => {
  it('rounds to the given precision and passes null/non-finite through as null', () => {
    expect(round1(12.34)).toBe(12.3);
    expect(round1(12.36)).toBe(12.4);
    expect(round1(null)).toBeNull();
    expect(round1(undefined)).toBeNull();
    expect(round1(NaN)).toBeNull();
    expect(round3(0.12345)).toBe(0.123);
  });
});

describe('suppressionFor', () => {
  it('NOT_TRACKED beats LOW_COVERAGE beats INSUFFICIENT_SAMPLE', () => {
    expect(
      suppressionFor({
        n: 100,
        minSample: 20,
        coverage: 0.9,
        minCoverage: 0.5,
        neverUsed: true,
      }),
    ).toBe('NOT_TRACKED');
    expect(
      suppressionFor({
        n: 100,
        minSample: 20,
        coverage: 0.2,
        minCoverage: 0.5,
      }),
    ).toBe('LOW_COVERAGE');
    expect(suppressionFor({ n: 5, minSample: 20 })).toBe('INSUFFICIENT_SAMPLE');
    expect(
      suppressionFor({
        n: 100,
        minSample: 20,
        coverage: 0.9,
        minCoverage: 0.5,
      }),
    ).toBeNull();
  });

  it('ignores coverage when not provided', () => {
    expect(suppressionFor({ n: 100, minSample: 20 })).toBeNull();
  });
});

describe('shapeDistribution', () => {
  it('nulls p50/p90 when suppressed but keeps n/invalid visible', () => {
    const d = shapeDistribution(5, 2, 10, 20, { n: 5, minSample: 20 });
    expect(d).toEqual({
      n: 5,
      invalid: 2,
      p50: null,
      p90: null,
      suppressed: 'INSUFFICIENT_SAMPLE',
    });
  });

  it('rounds p50/p90 to 1dp when not suppressed', () => {
    const d = shapeDistribution(50, 0, 10.36, 20.04, { n: 50, minSample: 20 });
    expect(d).toEqual({
      n: 50,
      invalid: 0,
      p50: 10.4,
      p90: 20,
      suppressed: null,
    });
  });
});

describe('shapeCounts', () => {
  it('matches computeRates definitions: rate = x / booked (not / past)', () => {
    const c = shapeCounts(
      row({ booked: 100, no_show: 20, completed: 60, past: 200 }),
    );
    expect(c.noShowRate).toBeCloseTo(0.2);
    expect(c.completionRate).toBeCloseTo(0.6);
  });

  it('reports null rates for an empty period rather than 0', () => {
    const c = shapeCounts(row({ booked: 0 }));
    expect(c.noShowRate).toBeNull();
    expect(c.completionRate).toBeNull();
  });
});

describe('shapeJourneyCoverages', () => {
  it('flags "never used" only when completed > 0 and the numerator is exactly 0', () => {
    expect(
      shapeJourneyCoverages(row({ completed: 50, completed_with_queue: 0 }))
        .queueNeverUsed,
    ).toBe(true);
    expect(
      shapeJourneyCoverages(row({ completed: 0, completed_with_queue: 0 }))
        .queueNeverUsed,
    ).toBe(false);
    expect(
      shapeJourneyCoverages(row({ completed: 50, completed_with_queue: 10 }))
        .queueNeverUsed,
    ).toBe(false);
  });
});

describe('shapeKpis', () => {
  it('suppresses every queue-only KPI as NOT_TRACKED when the queue is never used', () => {
    const cov = shapeJourneyCoverages(
      row({ completed: 40, completed_with_queue: 0, completed_with_timing: 0 }),
    );
    const kpis = shapeKpis(
      row({ completed: 40 }),
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    expect(kpis.waitToStart.suppressed).toBe('NOT_TRACKED');
    expect(kpis.readyDelay.suppressed).toBe('NOT_TRACKED');
    expect(kpis.arrivalOffset.suppressed).toBe('NOT_TRACKED');
    expect(kpis.startDelay.suppressed).toBe('NOT_TRACKED');
    expect(kpis.consultation.suppressed).toBe('NOT_TRACKED');
  });

  it('booking lead time is never gated by queue coverage', () => {
    const cov = shapeJourneyCoverages(
      row({ completed: 40, completed_with_queue: 0, completed_with_timing: 0 }),
    );
    const kpis = shapeKpis(
      row({ completed: 40, lead_n: 50, lead_p50: 3, lead_p90: 20 }),
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    expect(kpis.bookingLeadHours.suppressed).toBeNull();
    expect(kpis.bookingLeadHours.p50).toBe(3);
  });

  it('computes arrival late share only among appointments with a valid arrival offset', () => {
    const cov = shapeJourneyCoverages(
      row({ completed: 40, completed_with_queue: 40 }),
    );
    const kpis = shapeKpis(
      row({
        completed: 40,
        arrival_n: 40,
        arrival_late_n: 10,
        arrival_p50: -2,
        arrival_p90: 15,
      }),
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    expect(kpis.arrivalOffset.lateShare).toBeCloseTo(0.25);
  });

  it('carries the queue-vs-status-log source split on startDelay', () => {
    const cov = shapeJourneyCoverages(
      row({ completed: 40, completed_with_timing: 40 }),
    );
    const kpis = shapeKpis(
      row({
        completed: 40,
        start_delay_n: 40,
        start_from_queue: 30,
        start_from_log: 10,
      }),
      JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY,
      cov,
    );
    expect(kpis.startDelay.fromQueue).toBe(30);
    expect(kpis.startDelay.fromStatusLog).toBe(10);
  });
});

describe('shapeStages', () => {
  it('returns all 9 stages in fixed order, with CHECKOUT/FEEDBACK untracked', () => {
    const cov = shapeJourneyCoverages(row());
    const kpis = shapeKpis(row(), JOURNEY_THRESHOLDS.MIN_SAMPLE_SUMMARY, cov);
    const stages = shapeStages(row(), kpis);
    expect(stages.map((s) => s.key)).toEqual([
      'BOOKING',
      'REMINDER',
      'ARRIVAL',
      'WAIT_FOR_CALL',
      'CALL_TO_START',
      'CONSULTATION',
      'COMPLETION',
      'CHECKOUT',
      'FEEDBACK',
    ]);
    const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
    expect(byKey.CHECKOUT.tracked).toBe(false);
    expect(byKey.FEEDBACK.tracked).toBe(false);
    expect(byKey.CHECKOUT.duration).toBeNull();
    expect(byKey.BOOKING.tracked).toBe(true);
  });
});

describe('shapeDataQuality', () => {
  it('lists CHECKOUT and FEEDBACK as untracked stages', () => {
    const dq = shapeDataQuality(row());
    expect(dq.untrackedStages).toEqual(['CHECKOUT', 'FEEDBACK']);
  });

  it('surfaces the plain-timestamp / recall / delivery-status caveats', () => {
    const dq = shapeDataQuality(row());
    expect(dq.notes).toContain('PLAIN_TIMESTAMP_SESSION_TZ');
    expect(dq.notes).toContain('RECALL_OVERWRITES_CALL_TIME');
    expect(dq.notes).toContain('DELIVERY_STATUS_NOT_USED');
  });
});

describe('shapeComparison', () => {
  it('reports RANGE_TOO_WIDE above the max comparison range', () => {
    const r = shapeComparison(
      row({ booked: 10 }),
      { from: '2025-01-01', to: '2025-01-31' },
      400,
    );
    expect(r.comparisonUnavailable).toBe('RANGE_TOO_WIDE');
    expect(r.comparison).toBeNull();
  });

  it('reports NO_PRIOR_DATA when the prior row has zero bookings', () => {
    const r = shapeComparison(
      row({ booked: 0 }),
      { from: '2025-01-01', to: '2025-01-31' },
      30,
    );
    expect(r.comparisonUnavailable).toBe('NO_PRIOR_DATA');
  });

  it('returns comparable prior-period figures otherwise', () => {
    const r = shapeComparison(
      row({
        booked: 100,
        no_show: 10,
        wait_start_p50: 12.34,
        ready_delay_p50: 5,
        consult_p50: 20,
      }),
      { from: '2025-01-01', to: '2025-01-31' },
      30,
    );
    expect(r.comparisonUnavailable).toBeNull();
    expect(r.comparison).toEqual({
      range: { from: '2025-01-01', to: '2025-01-31' },
      waitToStartP50: 12.3,
      readyDelayP50: 5,
      consultationP50: 20,
      noShowRate: 0.1,
    });
  });
});

describe('shapeReminders', () => {
  it('reports NOT_ENABLED when disabled with no rows', () => {
    const r = shapeReminders(row(), [], {
      remindersEnabled: false,
      reminderLeadMinutes: [],
    });
    expect(r).toEqual({
      available: false,
      enabled: false,
      reason: 'NOT_ENABLED',
    });
  });

  it('reports NO_REMINDER_ROWS when enabled but nothing scheduled', () => {
    const r = shapeReminders(row(), [], {
      remindersEnabled: true,
      reminderLeadMinutes: [1440],
    });
    expect(r).toEqual({
      available: false,
      enabled: true,
      reason: 'NO_REMINDER_ROWS',
    });
  });

  it('aggregates outcomes, channels, lead times and skip reasons; unknown reasons become OTHER', () => {
    const rows: JourneyReminderRow[] = [
      {
        outcome: 'SENT',
        channel: 'WHATSAPP',
        skip_reason: null,
        lead_minutes: 1440,
        n: 40,
        stuck: 0,
      },
      {
        outcome: 'FAILED',
        channel: 'WHATSAPP',
        skip_reason: 'NO_PROVIDER',
        lead_minutes: 1440,
        n: 5,
        stuck: 0,
      },
      {
        outcome: 'FAILED',
        channel: 'EMAIL',
        skip_reason: 'some-raw-provider-text',
        lead_minutes: 60,
        n: 2,
        stuck: 0,
      },
      {
        outcome: 'CANCELLED',
        channel: 'WHATSAPP',
        skip_reason: null,
        lead_minutes: null,
        n: 3,
        stuck: 0,
      },
      {
        outcome: 'PENDING',
        channel: 'WHATSAPP',
        skip_reason: null,
        lead_minutes: null,
        n: 1,
        stuck: 1,
      },
    ];
    const r = shapeReminders(
      row({
        resolved_reminded: 35,
        no_show_reminded: 5,
        resolved_not_reminded: 40,
        no_show_not_reminded: 12,
      }),
      rows,
      { remindersEnabled: true, reminderLeadMinutes: [1440, 60] },
    );
    if (!r.available) throw new Error('expected available');
    expect(r.rows).toEqual({
      sent: 40,
      failed: 7,
      cancelled: 3,
      pending: 1,
      stuck: 1,
      failureRate: round3Manual(7 / 47),
    });
    expect(r.byChannel.find((c) => c.channel === 'WHATSAPP')).toEqual({
      channel: 'WHATSAPP',
      sent: 40,
      failed: 5,
    });
    expect(r.byLeadTime.find((l) => l.leadMinutes === 1440)).toEqual({
      leadMinutes: 1440,
      sent: 40,
      failed: 5,
    });
    expect(r.failureReasons).toContainEqual({
      reason: 'NO_PROVIDER',
      count: 5,
    });
    expect(r.failureReasons).toContainEqual({ reason: 'OTHER', count: 2 });
    expect(r.deliveryTracking).toBe('NOT_RELIABLE');
    expect(r.attendance.reminded).toEqual({
      resolved: 35,
      noShow: 5,
      share: round3Manual(5 / 35),
    });
    expect(r.attendance.notReminded).toEqual({
      resolved: 40,
      noShow: 12,
      share: round3Manual(12 / 40),
    });
    expect(r.attendance.comparable).toBe(true); // both groups >= 30
  });

  it('marks attendance not comparable when either group is under the minimum sample', () => {
    const rows: JourneyReminderRow[] = [
      {
        outcome: 'SENT',
        channel: 'WHATSAPP',
        skip_reason: null,
        lead_minutes: 1440,
        n: 40,
        stuck: 0,
      },
    ];
    const r = shapeReminders(
      row({
        resolved_reminded: 5,
        no_show_reminded: 1,
        resolved_not_reminded: 40,
        no_show_not_reminded: 4,
      }),
      rows,
      { remindersEnabled: true, reminderLeadMinutes: [1440] },
    );
    if (!r.available) throw new Error('expected available');
    expect(r.attendance.comparable).toBe(false);
  });
});

function round3Manual(n: number): number {
  return Math.round(n * 1000) / 1000;
}

describe('suggestDurationMinutes', () => {
  it('rounds up to the nearest 5 minutes', () => {
    expect(suggestDurationMinutes(41)).toBe(45);
    expect(suggestDurationMinutes(40)).toBe(40);
    expect(suggestDurationMinutes(40.1)).toBe(45);
  });

  it('clamps to [5, 480]', () => {
    expect(suggestDurationMinutes(1)).toBe(5);
    expect(suggestDurationMinutes(1000)).toBe(480);
  });
});

describe('shapeDurationSuggestions', () => {
  function dimRow(
    overrides: Partial<JourneyDimensionRow> = {},
  ): JourneyDimensionRow {
    return { ...row(), dim_key: 'svc-1', ...overrides };
  }

  it('skips a service with no label (not owned by this tenant) or inactive', () => {
    const rows = [
      dimRow({
        consult_n: 50,
        completed: 50,
        completed_with_timing: 50,
        consult_p75: 45,
      }),
    ];
    const labels = new Map([
      ['svc-1', { name: 'Cleaning', inactive: true, configuredMinutes: 30 }],
    ]);
    expect(shapeDurationSuggestions(rows, labels)).toEqual([]);
    expect(shapeDurationSuggestions(rows, new Map())).toEqual([]);
  });

  it('skips below the minimum sample or minimum coverage', () => {
    const labels = new Map([
      ['svc-1', { name: 'Cleaning', inactive: false, configuredMinutes: 30 }],
    ]);
    const lowSample = [
      dimRow({
        consult_n: 5,
        completed: 50,
        completed_with_timing: 50,
        consult_p75: 45,
      }),
    ];
    expect(shapeDurationSuggestions(lowSample, labels)).toEqual([]);
    const lowCoverage = [
      dimRow({
        consult_n: 25,
        completed: 100,
        completed_with_timing: 25,
        consult_p75: 45,
      }),
    ];
    expect(shapeDurationSuggestions(lowCoverage, labels)).toEqual([]);
  });

  it('skips when the suggested duration is too close to the configured one', () => {
    const labels = new Map([
      ['svc-1', { name: 'Cleaning', inactive: false, configuredMinutes: 40 }],
    ]);
    // p75=41 -> suggested 45; delta=5 which is >= max(5, 15%*40=6) -> 5 < 6, should be EXCLUDED
    const rows = [
      dimRow({
        consult_n: 25,
        completed: 25,
        completed_with_timing: 25,
        consult_p75: 41,
        consult_p50: 38,
        consult_p90: 50,
      }),
    ];
    expect(shapeDurationSuggestions(rows, labels)).toEqual([]);
  });

  it('includes a service whose suggested duration differs enough, sorted by delta descending, capped at 10', () => {
    const labels = new Map([
      ['svc-1', { name: 'A', inactive: false, configuredMinutes: 30 }],
      ['svc-2', { name: 'B', inactive: false, configuredMinutes: 30 }],
    ]);
    const rows = [
      dimRow({
        dim_key: 'svc-1',
        consult_n: 25,
        completed: 25,
        completed_with_timing: 25,
        consult_p75: 42,
        consult_p50: 38,
        consult_p90: 50,
      }), // suggested 45, delta 15
      dimRow({
        dim_key: 'svc-2',
        consult_n: 25,
        completed: 25,
        completed_with_timing: 25,
        consult_p75: 41,
        consult_p50: 36,
        consult_p90: 44,
      }), // suggested 45, delta 15... make it smaller
    ];
    const out = shapeDurationSuggestions(rows, labels);
    expect(out).toHaveLength(2);
    expect(out[0].serviceId).toBe('svc-1');
    expect(out[0].suggestedMinutes).toBe(45);
    expect(out[0].direction).toBe('LONGER');
  });
});

describe('shapeDurationExplanation', () => {
  function dimRow(
    overrides: Partial<JourneyDimensionRow> = {},
  ): JourneyDimensionRow {
    return { ...row(), dim_key: 'svc-1', ...overrides };
  }
  /** A service with `n` timed consultations out of `completed` completed. */
  function timed(
    key: string,
    n: number,
    p75: number,
    completed = n,
  ): JourneyDimensionRow {
    return dimRow({
      dim_key: key,
      consult_n: n,
      completed,
      completed_with_timing: n,
      consult_p50: p75 - 4,
      consult_p75: p75,
      consult_p90: p75 + 6,
      scheduled_p50: 30,
    });
  }
  const label = (
    name: string,
    configuredMinutes: number | null = 30,
    inactive = false,
  ) => ({ name, inactive, configuredMinutes });
  type Labels = Map<string, ReturnType<typeof label>>;

  const statusOf = (rows: JourneyDimensionRow[], labels: Labels, key: string) =>
    shapeDurationExplanation(rows, labels, 5).candidates.find(
      (c) => c.serviceId === key,
    )?.status;

  it('reports the exact gate each service stopped at, instead of dropping it', () => {
    const labels: Labels = new Map([
      ['ok', label('Needs longer', 30)],
      ['aligned', label('Aligned', 30)],
      ['few', label('Few', 30)],
      ['cov', label('Low coverage', 30)],
      ['nop', label('No percentile', 30)],
      ['gone', label('Gone', 30, true)],
    ]);
    const rows = [
      timed('ok', 25, 50), // suggested 50, delta 20 -> OK
      timed('aligned', 25, 26), // suggested 30, delta 0 -> aligned
      timed('few', 5, 45),
      dimRow({
        dim_key: 'cov',
        consult_n: 25,
        completed: 100,
        completed_with_timing: 25,
        consult_p75: 45,
      }),
      dimRow({
        dim_key: 'nop',
        consult_n: 25,
        completed: 25,
        completed_with_timing: 25,
        consult_p75: null,
      }),
      timed('gone', 25, 50),
    ];
    expect(statusOf(rows, labels, 'ok')).toBe('OK');
    expect(statusOf(rows, labels, 'aligned')).toBe('ALREADY_ALIGNED');
    expect(statusOf(rows, labels, 'few')).toBe('INSUFFICIENT_SAMPLE');
    expect(statusOf(rows, labels, 'cov')).toBe('LOW_TIMING_COVERAGE');
    expect(statusOf(rows, labels, 'nop')).toBe('NO_PERCENTILE');
    expect(statusOf(rows, labels, 'gone')).toBe('SERVICE_INACTIVE');
  });

  it('PARITY: candidates with status OK are exactly the suggestions list', () => {
    const labels: Labels = new Map([
      ['a', label('A', 30)],
      ['b', label('B', 30)],
      ['c', label('C', 30)],
      ['d', label('D', null)], // no configured duration -> still a suggestion
      ['e', label('E', 30, true)],
    ]);
    const rows = [
      timed('a', 25, 50),
      timed('b', 25, 26),
      timed('c', 3, 50),
      timed('d', 25, 50),
      timed('e', 25, 50),
    ];
    const suggestions = shapeDurationSuggestions(rows, labels)
      .map((s) => s.serviceId)
      .sort();
    const okCandidates = shapeDurationExplanation(rows, labels, 5)
      .candidates.filter((c) => c.status === 'OK')
      .map((c) => c.serviceId)
      .sort();
    expect(okCandidates).toEqual(suggestions);
    expect(suggestions).toEqual(['a', 'd']);
  });

  it('keeps the sample size visible but withholds percentiles below the minimum sample', () => {
    const labels: Labels = new Map([['few', label('Few', 30)]]);
    const [c] = shapeDurationExplanation([timed('few', 12, 45)], labels, 1)
      .candidates;
    expect(c.status).toBe('INSUFFICIENT_SAMPLE');
    expect(c.consultation.n).toBe(12);
    expect(c.consultation.p50).toBeNull();
    expect(c.consultation.p75).toBeNull();
    expect(c.suggestedMinutes).toBeNull();
    expect(c.direction).toBeNull();
  });

  it('an aligned service still reports its actual percentiles and the matching suggestion', () => {
    const labels: Labels = new Map([['al', label('Aligned', 30)]]);
    const [c] = shapeDurationExplanation([timed('al', 25, 26)], labels, 1)
      .candidates;
    expect(c.status).toBe('ALREADY_ALIGNED');
    expect(c.consultation.p75).toBe(26);
    expect(c.configuredMinutes).toBe(30);
    expect(c.suggestedMinutes).toBe(30);
    expect(c.direction).toBeNull();
  });

  it('a suggestion with no configured duration has no direction', () => {
    const labels: Labels = new Map([['x', label('X', null)]]);
    const [c] = shapeDurationExplanation([timed('x', 25, 50)], labels, 1)
      .candidates;
    expect(c.status).toBe('OK');
    expect(c.configuredMinutes).toBeNull();
    expect(c.direction).toBeNull();
  });

  describe('panel-level state', () => {
    const labels: Labels = new Map([
      ['a', label('A', 30)],
      ['gone', label('Gone', 30, true)],
    ]);

    it('NO_SERVICES_CONFIGURED only when the tenant count is known to be zero', () => {
      expect(shapeDurationExplanation([], new Map(), 0).state).toBe(
        'NO_SERVICES_CONFIGURED',
      );
      // an unknown count (blob cached before the field existed) never asserts it
      expect(shapeDurationExplanation([], new Map(), undefined).state).toBe(
        'NO_SERVICE_APPOINTMENTS',
      );
    });

    it('NO_SERVICE_APPOINTMENTS when services exist but none was booked alone in range', () => {
      expect(shapeDurationExplanation([], new Map(), 4).state).toBe(
        'NO_SERVICE_APPOINTMENTS',
      );
    });

    it('NO_TIMED_CONSULTATIONS when every live service has zero timed consultations', () => {
      // the inactive service has data but must not mask the live one's emptiness
      const rows = [timed('a', 0, 0, 7), timed('gone', 30, 50)];
      expect(shapeDurationExplanation(rows, labels, 4).state).toBe(
        'NO_TIMED_CONSULTATIONS',
      );
    });

    it('null once any live service has timed consultations (per-candidate status explains)', () => {
      expect(
        shapeDurationExplanation([timed('a', 3, 40)], labels, 4).state,
      ).toBeNull();
    });

    it('an inactive-only range is NO_SERVICE_APPOINTMENTS, not a false "no timed consultations"', () => {
      expect(
        shapeDurationExplanation([timed('gone', 30, 50)], labels, 4).state,
      ).toBe('NO_SERVICE_APPOINTMENTS');
    });
  });

  it('orders OK first (largest delta first), then aligned, then insufficient by sample size', () => {
    const labels: Labels = new Map([
      ['small', label('Small', 30)],
      ['big', label('Big', 30)],
      ['aligned', label('Aligned', 30)],
      ['few3', label('Few3', 30)],
      ['few9', label('Few9', 30)],
    ]);
    const rows = [
      timed('few3', 3, 45),
      timed('small', 25, 40), // suggested 40, delta 10
      timed('few9', 9, 45),
      timed('aligned', 25, 26),
      timed('big', 25, 60), // suggested 60, delta 30
    ];
    expect(
      shapeDurationExplanation(rows, labels, 5).candidates.map(
        (c) => c.serviceId,
      ),
    ).toEqual(['big', 'small', 'aligned', 'few9', 'few3']);
  });

  it('caps the payload but derives the state from the FULL list', () => {
    const many = JOURNEY_THRESHOLDS.MAX_DURATION_CANDIDATES + 10;
    const rows: JourneyDimensionRow[] = [];
    const labels: Labels = new Map();
    for (let i = 0; i < many; i++) {
      rows.push(timed(`s${i}`, 0, 0, 3));
      labels.set(`s${i}`, label(`S${String(i).padStart(3, '0')}`, 30));
    }
    const out = shapeDurationExplanation(rows, labels, many);
    expect(out.candidates).toHaveLength(
      JOURNEY_THRESHOLDS.MAX_DURATION_CANDIDATES,
    );
    expect(out.state).toBe('NO_TIMED_CONSULTATIONS');
  });

  it('skips a row whose service has no label (not this tenant)', () => {
    expect(
      shapeDurationExplanation([timed('ghost', 25, 50)], new Map(), 3)
        .candidates,
    ).toEqual([]);
  });
});
