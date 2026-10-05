/**
 * CAMPAIGN SMOKE — proves every NEW flow works end to end at trivial load, against
 * the lab dataset, BEFORE anything heavier runs. Not a performance test: any failure
 * here is a harness / fixture / contract defect and every later number would be
 * meaningless. Each persona's flows run once per iteration; optional packs that are
 * missing are skipped and listed in the setup log rather than failing silently.
 *
 *   node lab/run-campaign.mjs smoke-campaign
 */
import { sleep } from 'k6';
import { pickSession } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { notificationPoll } from '../flows/workspace.js';
import { dashboardPageView } from '../flows/dashboard.js';
import { appointmentsPageView, availabilityWindows } from '../flows/appointments.js';
import { crmSearch } from '../flows/crm.js';
import { queueView, queueBranches } from '../flows/queue.js';
import { journeySummary, journeyBreakdown } from '../flows/journey.js';
import { doctorDashboard, staffMe } from '../flows/doctor.js';
import { marketplaceBrowse } from '../flows/marketplace.js';
import { partnerReads, partnerWrites, partnerInbound } from '../flows/partner.js';
import { payLinkResolve } from '../flows/pay.js';
import { waStatus } from '../flows/wa.js';
import { publicDiscovery, bookingFunnel } from '../flows/booking.js';
import { crossTenantProbe } from '../flows/isolation.js';
import { book } from '../flows/appt-stress.js';

const STEP = 'smoke';

export const options = {
  setupTimeout: '300s',
  scenarios: {
    smoke: { executor: 'constant-vus', vus: Number(__ENV.VUS || 6), duration: __ENV.DURATION || '1m' },
  },
  thresholds: Object.assign(steadyThresholds(), {
    // Smoke must be CLEAN: any business failure is a defect, not load behaviour.
    business_check_failed: ['rate<0.01'],
  }),
};

export function setup() { return campaignSetup('smoke-campaign'); }

const ROLE_SETS = [['receptionist', 'manager'], ['doctor', 'nurse'], ['owner']];

export default function () {
  // Each VU plays the role set matching its id, so one smoke covers all three.
  const roles = ROLE_SETS[(__VU - 1) % ROLE_SETS.length];
  const s = pickSession(__VU, roles, 0);
  if (s) {
    notificationPoll(s, STEP);
    if (roles[0] === 'receptionist') {
      dashboardPageView(s, STEP);
      appointmentsPageView(s, STEP);
      availabilityWindows(s, STEP, 3);
      crmSearch(s, STEP);
      queueBranches(s, STEP);
      queueView(s, STEP);
      book(s, STEP, 'spread');
    } else if (roles[0] === 'doctor') {
      // Nurses have no staff profile: /staff/me* answer 404 for them, correctly. Only doctors run the
      // doctor pages; the nurse still polls the bell and the queue.
      if (s.role === 'doctor') {
        doctorDashboard(s, STEP);
        staffMe(s, STEP);
      }
      queueView(s, STEP);
    } else {
      dashboardPageView(s, STEP);
      journeySummary(s, STEP);
      journeyBreakdown(s, STEP);
    }
    crossTenantProbe(s, STEP);
  }
  publicDiscovery(STEP);
  bookingFunnel(STEP);
  marketplaceBrowse(STEP);
  // Partner keys are limited to 120 requests/min each (not lifted by NODE_ENV=test). A smoke must be
  // clean, so pace below it; the limit itself is exercised on purpose by the public-api scenario.
  if ((__ITER || 0) % 4 === 0) {
    partnerReads(STEP);
    partnerWrites(STEP);
    partnerInbound(STEP, true);
  }
  payLinkResolve(STEP);
  waStatus(STEP, true);
  sleep(1);
}

export const handleSummary = makeSummary({ scenario: 'smoke-campaign' });
