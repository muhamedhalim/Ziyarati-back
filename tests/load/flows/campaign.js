/**
 * THE PERSONA ENGINE — what one virtual user DOES for the whole 20K campaign.
 *
 * A VU is a person with a tab open, not a request robot. Its behaviour is driven
 * by TIMERS, derived from what the frontend really does (not assumed):
 *   - notification bell:  GET /notifications/inbox/unread-count every 30 s on every
 *     authenticated page (the product's most frequent request);
 *   - queue board:        GET /queue every 3 s while the queue tab is focused;
 *   - a user ACTION every `think` seconds (exponential, mean LT_THINK_MS).
 * One loop tick = sleep(LT_TICK_S, default 1 s), so polls fire on schedule while
 * the VU "reads the page".
 *
 * THINK TIME.  LT_THINK_MS=15000 (default) is the realistic-concurrency model.
 * LT_THINK_MS=3000 reproduces the September `prod-mix` closed-loop model, so
 * results stay comparable. Reports state which was used; VUs, req/s and in-flight
 * requests are always reported separately.
 *
 * PERSONAS (LT_PERSONA_MIX, percent, any subset). DEFAULT SHARES ARE A MODELLING
 * ASSUMPTION — production analytics are NOT MEASURED — and every report says so:
 *   receptionist:38, doctor:20, owner:10, idle:5, public:20, marketplace:5, partner:2
 *
 * RANDOMNESS is a per-VU seeded PRNG (LT_SEED), so a run's action sequence is
 * reproducible.  HOT TENANT: LT_HOT_SHARE pins that fraction of staff VUs to the
 * hot tenant's sessions.
 */
import exec from 'k6/execution';
import { sleep } from 'k6';
import { pickSession, bucketOf, canAny } from '../helpers/sessions.js';
import { dashboardPageView, staffPerformanceReport } from './dashboard.js';
import {
  appointmentsPageView, appointmentDetail, availabilityWindows,
  createAppointment, updateStatus, appointmentsFiltered,
} from './appointments.js';
import { crmSearch, crmList } from './crm.js';
import {
  staffPageView, activityPageView, activitySearch, notificationPoll, notificationInbox,
} from './workspace.js';
import { publicDiscovery, bookingFunnel, bookingConfirm } from './booking.js';
import { queueView, queueCycle } from './queue.js';
import { marketplaceBrowse } from './marketplace.js';
import { journeySummary, journeyBreakdown } from './journey.js';
import { doctorDashboard, staffMe, doctorAppointmentDetail } from './doctor.js';
import { partnerReads, partnerWrites, partnerInbound } from './partner.js';
import { payLinkResolve, payCheckout } from './pay.js';
import { guestAiTurn } from './ai.js';
import { crossTenantProbe } from './isolation.js';

// ---------------------------------------------------------------- configuration
const num = (k, d) => (__ENV[k] === undefined || __ENV[k] === '' ? d : Number(__ENV[k]));
const THINK_MS = num('LT_THINK_MS', 15000);
const TICK_S = num('LT_TICK_S', 1);
const SEED = num('LT_SEED', 1);
const HOT_SHARE = num('LT_HOT_SHARE', 0);
const QUEUE_TAB = { receptionist: num('LT_QUEUE_TAB_RECEPTION', 0.5), doctor: num('LT_QUEUE_TAB_DOCTOR', 0.8) };
const RUN_SEED = num('LT_RUN_SEED', Math.floor(Date.now() / 60000) % 100000);
const ISOLATION = __ENV.LT_ISOLATION !== 'false';
const AI_ON = __ENV.LT_AI === 'true';
const BOOK_CONFIRM = __ENV.BOOKING_CONFIRM === 'true';

const MIX = (__ENV.LT_PERSONA_MIX ||
  'receptionist:38,doctor:20,owner:10,idle:5,public:20,marketplace:5,partner:2')
  .split(',').map((s) => { const [p, w] = s.split(':'); return [p.trim(), Number(w)]; });

const ROLES = {
  receptionist: ['receptionist', 'manager'],
  doctor: ['doctor', 'nurse'],
  owner: ['owner'],
  idle: ['receptionist', 'owner', 'doctor'],
};

const ACTIONS = {
  receptionist: [['appointments-list', 18], ['availability', 20], ['appointment-create', 10],
    ['crm-search', 12], ['crm-list', 4], ['appointment-detail', 8], ['staff-list', 4],
    ['dashboard', 8], ['notification-inbox', 4], ['queue-cycle', 12]],
  doctor: [['doctor-dashboard', 40], ['staff-me', 15], ['appointment-detail', 15],
    ['notification-inbox', 10], ['doctor-dashboard', 20]],
  owner: [['dashboard', 28], ['journey-summary', 12], ['journey-breakdown', 8], ['staff-performance', 8],
    ['activity', 14], ['crm-search', 8], ['appointments-list', 10], ['staff-list', 4],
    ['notification-inbox', 4], ['crm-list', 4]],
  public: [['public-discovery', 30], ['booking-funnel', 30], ['pay-link', 20], ['guest-ai', 20]],
  marketplace: [['marketplace', 100]],
  partner: [['partner-reads', 50], ['partner-writes', 30], ['partner-inbound', 20]],
  idle: [['nothing', 100]],
};

function table(persona) {
  const out = [];
  for (const [name, w] of ACTIONS[persona] || []) for (let i = 0; i < w; i++) out.push(name);
  return out;
}
const TABLES = {};
for (const p of Object.keys(ACTIONS)) TABLES[p] = table(p);

// -------------------------------------------------------------------- PRNG
let _s = 0;
function seedRng(vu) { _s = ((SEED + vu * 2654435761) >>> 0) || 1; }
function rng() { // mulberry32
  _s = (_s + 0x6D2B79F5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function thinkMs() {
  const mean = THINK_MS;
  const v = -Math.log(1 - rng()) * mean;
  return Math.min(Math.max(v, Math.min(1000, mean)), mean * 4);
}

// ------------------------------------------------------------ ladder step tags
const secs = (s) => {
  const m = /^(\d+)(s|m|h)$/.exec(String(s));
  if (!m) return Number(s) || 0;
  return Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
};
export const LEVELS = String(__ENV.LT_LEVELS || '100,500,1000,2500,5000,10000,15000,20000')
  .split(',').map((x) => Number(x.trim())).filter(Boolean);
export const RAMP = __ENV.LT_RAMP || '120s';
export const HOLD = __ENV.LT_HOLD || '180s';

/** ramping-vus stages for the ladder: ramp to each level, hold it, next level. */
export function ladderStages(levels, ramp, hold) {
  const st = [];
  for (const l of (levels || LEVELS)) {
    st.push({ duration: ramp || RAMP, target: l });
    st.push({ duration: hold || HOLD, target: l });
  }
  return st;
}

/**
 * The step tag for "now" (modes: ladder | soak | phases; else LT_STEP). In ladder mode it is `L<level>` during a level's HOLD
 * window and `ramp` while ramping, so the report can score each level on its hold
 * window only. Otherwise LT_STEP (default `steady`).
 */
export function stepNow() {
  const mode = __ENV.LT_MODE;
  if (mode !== 'ladder' && mode !== 'soak' && mode !== 'phases') return __ENV.LT_STEP || 'steady';
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  if (mode === 'soak') {
    // Fixed windows (default 10 min) so drift is visible: w0, w1, ... capped at w35.
    return 'w' + Math.min(35, Math.floor(t / num('LT_SOAK_WINDOW_S', 600)));
  }
  if (mode === 'phases') {
    // LT_PHASES="pre:180,surge:150,recovery:300" -> step name by cumulative time.
    let acc = 0;
    for (const part of String(__ENV.LT_PHASES || 'pre:180,surge:150,recovery:300').split(',')) {
      const [name, dur] = part.split(':');
      acc += Number(dur);
      if (t < acc) return name.trim();
    }
    return 'drain';
  }
  const r = secs(RAMP); const h = secs(HOLD);
  const per = r + h;
  const i = Math.floor(t / per);
  if (i >= LEVELS.length) return 'drain';
  return (t - i * per) < r ? 'ramp' : 'L' + LEVELS[i];
}

// ------------------------------------------------------------------ per-VU state
const ST = { init: false, persona: null, session: null, nextBell: 0, nextQueue: 0, nextAction: 0, queueTab: false, lastAppt: null, transitionable: null };

export function personaOf(vu) {
  const b = bucketOf(vu);
  const total = MIX.reduce((a, [, w]) => a + w, 0) || 100;
  let acc = 0;
  for (const [p, w] of MIX) { acc += (w / total) * 100; if (b < acc) return p; }
  return MIX[MIX.length - 1][0];
}

function boot() {
  seedRng(__VU);
  ST.persona = personaOf(__VU);
  const roles = ROLES[ST.persona];
  if (roles) {
    ST.session = pickSession(__VU, roles, HOT_SHARE);
    if (ST.session) ST.session.runSeed = RUN_SEED;
  }
  ST.queueTab = !!QUEUE_TAB[ST.persona] && rng() < QUEUE_TAB[ST.persona];
  // Spread first polls/actions so 20K VUs do not wake on the same millisecond.
  const now = Date.now();
  ST.nextBell = now + rng() * 30000;
  ST.nextQueue = now + rng() * 3000;
  ST.nextAction = now + rng() * Math.min(THINK_MS, 30000);
  ST.init = true;
}

/** A doctor's dashboard list yields one of THEIR OWN appointment ids to open later. */
function rememberFirstAppt(res) {
  try { const b = res && res[0] && res[0].json(); if (b && b.data && b.data.length) ST.lastAppt = b.data[0].id; } catch (e) { /* ignore */ }
}

function perform(action, s, step) {
  switch (action) {
    case 'appointments-list': {
      const res = appointmentsPageView(s, step);
      if (res && res[2] && res[2].status === 200) {
        try { const b = res[2].json(); if (b.data && b.data.length) ST.lastAppt = b.data[Math.floor(rng() * b.data.length)].id; } catch (e) { /* ignore */ }
      }
      return;
    }
    case 'appointment-detail':
      if (ST.persona === 'doctor') {
        if (ST.lastAppt) doctorAppointmentDetail(s, ST.lastAppt, step); else rememberFirstAppt(doctorDashboard(s, step));
      } else if (ST.lastAppt) appointmentDetail(s, ST.lastAppt, step); else appointmentsPageView(s, step);
      return;
    case 'availability': availabilityWindows(s, step, 1 + Math.floor(rng() * 10)); return;
    case 'appointment-create': {
      const res = createAppointment(s, step, false);
      if (res && res.status === 201) { try { ST.transitionable = res.json().id; } catch (e) { /* ignore */ } }
      if (ST.transitionable && rng() < 0.3) { updateStatus(s, ST.transitionable, 'IN_PROGRESS', step); ST.transitionable = null; }
      return;
    }
    case 'appointments-filtered': appointmentsFiltered(s, step); return;
    case 'crm-search': crmSearch(s, step); return;
    case 'crm-list': crmList(s, step); return;
    case 'staff-list': staffPageView(s, step); return;
    case 'dashboard': dashboardPageView(s, step); return;
    case 'staff-performance': staffPerformanceReport(s, step); return;
    case 'activity': if (rng() < 0.3) activitySearch(s, step); else activityPageView(s, step); return;
    case 'notification-inbox': notificationInbox(s, step); return;
    case 'journey-summary': journeySummary(s, step); return;
    case 'journey-breakdown': journeyBreakdown(s, step); return;
    case 'doctor-dashboard': rememberFirstAppt(doctorDashboard(s, step)); return;
    case 'staff-me': staffMe(s, step); return;
    case 'queue-cycle': queueCycle(s, step); return;
    case 'nothing': return;
    default: return;
  }
}

function performPublic(action, step) {
  switch (action) {
    case 'public-discovery': publicDiscovery(step); return;
    case 'booking-funnel': {
      const ctx = bookingFunnel(step);
      if (BOOK_CONFIRM) bookingConfirm(ctx, step);
      return;
    }
    case 'pay-link': payLinkResolve(step); if (rng() < 0.5) payCheckout(step); return;
    case 'guest-ai': if (AI_ON) guestAiTurn(step); return;
    default: return;
  }
}

/** One loop tick of the VU. Call from a scenario's exec function. */
export function personaTick() {
  if (!ST.init) boot();
  const step = stepNow();
  const now = Date.now();
  const p = ST.persona;

  if (p === 'public') {
    if (now >= ST.nextAction) { performPublic(TABLES.public[Math.floor(rng() * TABLES.public.length)], step); ST.nextAction = now + thinkMs(); }
  } else if (p === 'marketplace') {
    if (now >= ST.nextAction) { marketplaceBrowse(step); ST.nextAction = now + thinkMs(); }
  } else if (p === 'partner') {
    if (now >= ST.nextAction) {
      const a = TABLES.partner[Math.floor(rng() * TABLES.partner.length)];
      if (a === 'partner-reads') partnerReads(step);
      else if (a === 'partner-writes') partnerWrites(step);
      else partnerInbound(step, rng() < 0.2);
      ST.nextAction = now + thinkMs();
    }
  } else if (ST.session) {
    const s = ST.session;
    if (now >= ST.nextBell) { notificationPoll(s, step); ST.nextBell = now + 30000 + rng() * 1000; }
    if (ST.queueTab && now >= ST.nextQueue) { queueView(s, step); ST.nextQueue = now + 3000; }
    if (now >= ST.nextAction) {
      const t = TABLES[p];
      perform(t[Math.floor(rng() * t.length)], s, step);
      if (ISOLATION && rng() < 0.05) crossTenantProbe(s, step);
      ST.nextAction = now + thinkMs();
    }
  }
  sleep(TICK_S);
}

export function describeModel() {
  return {
    thinkMs: THINK_MS, tickS: TICK_S, seed: SEED, hotShare: HOT_SHARE,
    mix: MIX.map(([p, w]) => `${p}:${w}`).join(','), ladder: LEVELS, ramp: RAMP, hold: HOLD,
    queueTab: QUEUE_TAB, ai: AI_ON, bookingConfirm: BOOK_CONFIRM, isolation: ISOLATION,
  };
}
