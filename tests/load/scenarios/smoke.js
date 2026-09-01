/**
 * STAGE 0 — SMOKE.
 *
 * Not a performance test. Its only job is to prove, at trivial load, that every
 * flow the suite depends on actually works end to end: auth, tenant context
 * discovery, each page view, the availability engine, the write path and the
 * public funnel. If this is not green, every number produced by the heavier
 * scenarios is meaningless.
 *
 * Run:
 *   docker compose -f tests/load/docker-compose.yml run --rm k6 run /scripts/scenarios/smoke.js
 */
import { sleep } from 'k6';
import { buildSessions, sessionFor } from '../helpers/auth.js';
import { dashboardPageView, staffPerformanceReport } from '../flows/dashboard.js';
import {
  appointmentsPageView, availabilityWindows, createAppointment, appointmentDetail,
} from '../flows/appointments.js';
import { crmPageView, crmSearch } from '../flows/crm.js';
import { staffPageView, activityPageView, notificationPoll } from '../flows/workspace.js';
import { publicDiscovery, bookingFunnel } from '../flows/booking.js';

const STEP = 'smoke';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: __ENV.DURATION || '1m',
    },
  },
  thresholds: {
    // Smoke must be clean. Any failure here is a harness or fixture defect.
    'http_req_failed': ['rate<0.01'],
    'business_check_failed': ['rate<0.01'],
    'http_429_rate_limited': ['count<1'],
  },
};

export function setup() {
  const sessions = buildSessions();
  const s = sessions[0];
  console.log(
    `smoke setup: ${sessions.length} sessions | branches=${s.branchIds.length} ` +
    `staff=${s.staffIds.length} customers=${s.customerIds.length} services=${s.serviceIds.length}`,
  );
  return { sessions };
}

export default function (data) {
  const session = sessionFor(data.sessions, __VU);

  dashboardPageView(session, STEP);
  const appts = appointmentsPageView(session, STEP);
  crmPageView(session, STEP);
  crmSearch(session, STEP);
  staffPageView(session, STEP);
  activityPageView(session, STEP);
  notificationPoll(session, STEP);
  availabilityWindows(session, STEP, 3);
  staffPerformanceReport(session, STEP);

  // Detail view of a real appointment from the list we just fetched.
  if (appts && appts[2] && appts[2].status === 200) {
    const list = appts[2].json();
    if (list.data && list.data.length) {
      appointmentDetail(session, list.data[0].id, STEP);
    }
  }

  // One write, non-contended.
  createAppointment(session, STEP, false);

  // Public surface.
  publicDiscovery(STEP);
  bookingFunnel(STEP);

  sleep(1);
}
