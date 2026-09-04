/**
 * The realistic mixed workload.
 *
 * WEIGHTS ARE DERIVED FROM THE CODE, NOT ASSUMED. What the frontend actually
 * does, per the request-assertion tests and the query configs:
 *
 *  - `/notifications/inbox/unread-count` polls every 30s on EVERY authenticated
 *    page in all four shells. It is by a wide margin the most-requested endpoint
 *    in the product, so it carries the largest single share here. The commonly
 *    proposed "notifications 5%" understates it by roughly an order of magnitude.
 *  - Page views re-issue their list queries only when the 60s FRESH staleTime
 *    has elapsed (`refetchOnMount` is true, `refetchOnWindowFocus` is false), so
 *    a user clicking around re-pays list cost roughly once a minute per page.
 *  - Appointment WRITES are rare relative to reads. A receptionist books a
 *    handful of appointments per hour while viewing hundreds of pages; a 15%
 *    write share would model a data-entry robot, not a clinic. Writes are kept
 *    at ~6% combined, which still saturates the per-tenant usage-row lock long
 *    before a real clinic would.
 *  - Activity is owner-only (`audit.read`), so its effective share is roughly
 *    half of its nominal weight given the owner/receptionist session split.
 *
 * Set MIX_PROFILE=write-heavy to shift the balance toward writes when
 * specifically hunting the transaction bottleneck.
 */
import { dashboardPageView, staffPerformanceReport } from './dashboard.js';
import {
  appointmentsPageView, appointmentDetail, availabilityWindows,
  createAppointment, updateStatus, appointmentsFiltered,
} from './appointments.js';
import { crmPageView, crmSearch, crmList } from './crm.js';
import {
  staffPageView, activityPageView, activitySearch,
  notificationPoll, notificationInbox,
} from './workspace.js';

const PROFILES = {
  default: [
    ['notification-poll', 22],
    ['appointments-list', 16],
    ['dashboard', 13],
    ['crm-search', 11],
    ['appointment-detail', 8],
    ['staff-list', 7],
    ['availability', 7],
    ['activity', 5],
    ['crm-list', 4],
    ['appointments-filtered', 3],
    ['notification-inbox', 3],
    ['appointment-create', 4],
    ['appointment-status', 2],
    ['staff-performance', 1],
  ],
  'write-heavy': [
    ['notification-poll', 10],
    ['appointments-list', 12],
    ['dashboard', 6],
    ['crm-search', 6],
    ['availability', 16],
    ['appointment-create', 30],
    ['appointment-status', 14],
    ['staff-list', 6],
  ],
  /**
   * `prod-mix` — the massive-scale phase's production-style distribution.
   *
   * The brief specified shares at the REQUEST level (25% dashboard, 20%
   * availability, 15% creation, ...). These weights are per ITERATION, and an
   * iteration is 1-6 requests, so a weight is target_share / requests_per_action
   * rather than the share itself — copying the percentages straight into this
   * table would have produced roughly 6% dashboard traffic, not 25%.
   *
   *   action                requests/iter   -> resulting request share
   *   dashboard             4.5 (6 owner / 3 receptionist)   ~24%
   *   availability          1                                ~20%
   *   appointment-create    1                                ~15%
   *   crm-search/list       1                                ~10%
   *   appointments list+detail  3 / 5                        ~9%
   *   staff-list            2                                ~5%
   *   notification-poll     1                                ~5%
   *   analytics (staff perf) 1, owner-only                   ~3%
   *   filtered + activity   1 / 5                            ~4%
   *
   * This deliberately books ~2.5x more often than `default`, whose write share
   * was derived from what a receptionist actually does. `default` is the honest
   * model of today's product; `prod-mix` is the brief's stress-weighted model.
   * Both were run — see the report's workload-distribution section.
   */
  'prod-mix': [
    ['availability', 40],
    ['appointment-create', 30],
    ['crm-search', 12],
    ['dashboard', 11],
    ['notification-poll', 10],
    ['staff-performance', 10],
    ['crm-list', 8],
    ['staff-list', 5],
    ['appointments-filtered', 4],
    ['appointments-list', 3],
    ['appointment-detail', 2],
    ['activity', 1],
  ],
  'read-only': [
    ['notification-poll', 24],
    ['appointments-list', 18],
    ['dashboard', 15],
    ['crm-search', 13],
    ['appointment-detail', 9],
    ['staff-list', 8],
    ['availability', 7],
    ['activity', 6],
  ],
};

function buildTable(profile) {
  const rows = PROFILES[profile] || PROFILES.default;
  const table = [];
  for (const [name, weight] of rows) {
    for (let i = 0; i < weight; i++) table.push(name);
  }
  return table;
}

const TABLE = buildTable(__ENV.MIX_PROFILE || 'default');

/**
 * Two separate handles, deliberately.
 *
 * `lastAppointmentId` is any appointment seen in a list — fine to OPEN.
 * `transitionableId` is one this suite CREATED, and is the only thing we are
 * allowed to change the status of.
 *
 * Why: 83% of the seeded appointments sit in a terminal state (COMPLETED /
 * NO_SHOW / CANCELLED), which legally accepts no transition at all. Picking a
 * random one and pushing it to IN_PROGRESS earns a correct 409 roughly four
 * times in five, and that showed up as a steady ~0.5% "error rate" at every
 * load level — an artefact of the test, not a property of the system. Only
 * transitioning freshly-created (CONFIRMED) appointments removes it.
 */
let lastAppointmentId = null;
let transitionableId = null;

export function mixedIteration(session, step) {
  const action = TABLE[Math.floor(Math.random() * TABLE.length)];

  switch (action) {
    case 'notification-poll':
      return notificationPoll(session, step);
    case 'notification-inbox':
      return notificationInbox(session, step);
    case 'dashboard':
      return dashboardPageView(session, step);
    case 'staff-performance':
      return staffPerformanceReport(session, step);
    case 'crm-search':
      return crmSearch(session, step);
    case 'crm-list':
      return crmList(session, step);
    case 'staff-list':
      return staffPageView(session, step);
    case 'activity':
      return (Math.random() < 0.3)
        ? activitySearch(session, step)
        : activityPageView(session, step);
    case 'availability':
      return availabilityWindows(session, step, 1 + Math.floor(Math.random() * 10));
    case 'appointments-filtered':
      return appointmentsFiltered(session, step);

    case 'appointments-list': {
      const res = appointmentsPageView(session, step);
      // Cache an id so the detail action has something real to open.
      if (res && res[2] && res[2].status === 200) {
        const body = res[2].json();
        if (body.data && body.data.length) {
          lastAppointmentId = body.data[Math.floor(Math.random() * body.data.length)].id;
        }
      }
      return res;
    }

    case 'appointment-detail':
      if (!lastAppointmentId) return appointmentsPageView(session, step);
      return appointmentDetail(session, lastAppointmentId, step);

    case 'appointment-create': {
      const res = createAppointment(session, step, false);
      if (res && res.status === 201) {
        try {
          const id = res.json().id;
          lastAppointmentId = id;
          transitionableId = id;   // created CONFIRMED -> a legal transition exists
        } catch (e) { /* ignore */ }
      }
      return res;
    }

    case 'appointment-status': {
      // Only ever transition an appointment THIS suite created. It is CONFIRMED,
      // so CONFIRMED -> IN_PROGRESS is a legal edge. Re-sending the same status
      // is a 400 by design, so each id is consumed exactly once.
      if (!transitionableId) return notificationPoll(session, step);
      const res = updateStatus(session, transitionableId, 'IN_PROGRESS', step);
      transitionableId = null;
      return res;
    }

    default:
      return notificationPoll(session, step);
  }
}

export function mixDescription() {
  return (__ENV.MIX_PROFILE || 'default');
}
