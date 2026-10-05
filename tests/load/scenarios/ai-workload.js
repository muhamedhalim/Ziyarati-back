/**
 * AI WORKLOAD — the platform's own cost of an AI turn, with the provider STUBBED.
 *
 * HARD RULE: the lab API runs with OPENAI_API_KEY blank (Noop provider, canned echo,
 * 0 tokens, inert tools). lab/run-campaign.mjs verifies that before this scenario may
 * start. This measures the orchestration — claim, quota reserve, ~15-20 write statements
 * per turn, a per-conversation hot row, Redis turn limiters — NOT OpenAI latency or spend.
 * A real-provider run is a separate, deliberately small manual step; latency attributable
 * to OpenAI is never mixed into these numbers.
 *
 *   rest        POST /ai/orchestrator/message as staff (201 expected)
 *   ws-guest    guest widget: mint guest -> Socket.IO /ai -> one turn -> ai:done
 *   ws-staff    staff access token over the same gateway (principal DB lookup per connect)
 *   ws-limits   ONE staff identity firing ~1 turn/s for 90 s: after 30 turns in a 60 s window
 *               the gateway must answer RATE_LIMITED (measured, not relaxed)
 *   ws-connect  connect + auth only, held open: the connection-capacity number
 *
 * Default limits are NOT relaxed: authenticated 30 turns/60 s, guest 15/60 s, guest by
 * source 200/600 s, platform guest budget 20,000/day. At scale these WILL bind — the
 * share of `ai_turn_rate_limited` is the finding, and a capacity run with them raised
 * is a separately LABELLED run (set the env on the lab API, never here).
 */
import ws from 'k6/ws';
import http from 'k6/http';
import { sleep } from 'k6';
import { pickSession, sessionIndex, sessionsArr } from '../helpers/sessions.js';
import { campaignSetup, makeSummary } from '../helpers/boot.js';
import { aiRestTurn, aiSocketTurn, guestAiTurn } from '../flows/ai.js';
import { steadyThresholds } from '../config/campaign-thresholds.js';
import { num, str, secs, arrival, constantVus, startAt } from '../config/kit.js';
import { BASE } from '../helpers/auth.js';
import { wsConnectFail } from '../helpers/metrics.js';

const PARTS = str('LT_AI_PARTS', 'rest,ws-guest,ws-staff,ws-limits,ws-connect').split(',');
const DUR = str('LT_DURATION', '3m');
const GAP = secs(str('LT_GAP', '30s'));
const WS_URL = (__ENV.LT_WS_URL || BASE.replace(/^http/, 'ws')) + '/socket.io/?EIO=4&transport=websocket';

const DEFS = {
  rest: () => [arrival('rest', num('LT_AI_REST_RATE', 10), DUR, { part: 'rest' }), secs(DUR)],
  'ws-guest': () => [arrival('wsGuest', num('LT_AI_GUEST_RATE', 10), DUR, { part: 'ws-guest' }), secs(DUR)],
  'ws-staff': () => [arrival('wsStaff', num('LT_AI_STAFF_RATE', 5), DUR, { part: 'ws-staff' }), secs(DUR)],
  'ws-limits': () => [arrival('wsLimits', 1, '90s', { part: 'ws-limits' }), 90],
  'ws-connect': () => [constantVus('wsConnect', num('LT_WS_HOLD_VUS', 500), DUR, { part: 'ws-connect' }), secs(DUR)],
};
const scenarios = {};
let t = 0;
for (const p of PARTS) {
  if (!DEFS[p]) continue;
  const [def, len] = DEFS[p]();
  scenarios[p.replace('-', '_')] = startAt(def, t);
  t += len + GAP;
}

export const options = { setupTimeout: '120s', scenarios, thresholds: steadyThresholds() };
export function setup() { return campaignSetup('ai-workload'); }

const staff = () => pickSession(__VU, ['owner', 'manager'], 0);

export function rest() { const s = staff(); if (s) aiRestTurn(s, 'steady'); }
export function wsGuest() { guestAiTurn('steady'); }
export function wsStaff() { const s = staff(); if (s) aiSocketTurn(s.access, 'steady'); }
export function wsLimits() {
  // The SAME identity every time: the first owner session in the pack.
  const i = (sessionIndex().byRole.owner || [])[0];
  if (i === undefined) return;
  aiSocketTurn(sessionsArr[i].access, 'steady');
}
/** Connect, authenticate, hold the socket for ~30 s answering pings, then close. */
export function wsConnect() {
  const s = staff();
  if (!s) { sleep(5); return; }
  const jar = new http.CookieJar();
  const res = ws.connect(WS_URL, { jar, tags: { step: 'steady', name: 'ws/ai-hold' } }, (socket) => {
    socket.on('message', (m) => {
      if (m.charAt(0) === '0') socket.send(`40/ai,${JSON.stringify({ token: s.access })}`);
      else if (m === '2') socket.send('3');
    });
    socket.setTimeout(() => socket.close(), 30000);
  });
  if (!res || res.status !== 101) wsConnectFail.add(1, { step: 'steady' });
}

export const handleSummary = makeSummary({ scenario: 'ai-workload', parts: PARTS });
