/**
 * AI surface — REST orchestrator and the Socket.IO `/ai` realtime gateway.
 *
 * COST CONTROL (hard rule): the lab API runs with OPENAI_API_KEY blank, so the
 * provider factory falls back to the Noop provider (canned echo, 0 tokens, no
 * tools). The WHOLE orchestration still runs — claim, quota reserve, message and
 * usage writes (~15-20 write statements per turn), per-conversation hot row,
 * Redis turn limiters — so this measures the platform's own cost, not OpenAI's.
 * Production mode would return 503 for a blank key, which is why lab/run-campaign
 * refuses a non-lab target. A real-provider run is a separate, small, manual step.
 *
 * Socket.IO v4 over a raw websocket (Engine.IO v4 framing), as the contract says:
 *   server  `0{...}`                 -> client `40/ai,{"token":"<jwt>"}`   (join namespace)
 *   server  `40/ai,{...}` + `42/ai,["ai:connected",...]`
 *   client  `42/ai,["ai:message",{"content":"...","channel":"WEBSITE"}]`
 *   server  `42/ai,["ai:done",{...}]`   (or `ai:error`)   ; every `2` ping needs a `3`
 * Admission: a client that sends NO Origin and NO Cookie is admitted. k6's ws
 * would attach the VU cookie jar, so every connection uses a throw-away jar.
 *
 * Default limits are NOT relaxed here: authenticated 30 turns/60 s, guest 15/60 s,
 * guest-by-source 200/600 s, platform guest budget 20,000/day. Hitting them is the
 * measured behaviour (`ai_turn_rate_limited`), not an error.
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { Trend } from 'k6/metrics';
import { BASE, authWrite } from '../helpers/auth.js';
import { observe, aiTurnDone, aiTurnRateLimited, aiTurnError, wsConnectFail } from '../helpers/metrics.js';
import { businessErrors } from '../helpers/checks.js';

export const aiTurnLatency = new Trend('ai_turn_latency_ms', true);

const WS_URL = (__ENV.LT_WS_URL || BASE.replace(/^http/, 'ws')) + '/socket.io/?EIO=4&transport=websocket';
const TURN_TIMEOUT_MS = Number(__ENV.LT_AI_TIMEOUT_MS || 30000);

/** REST turn as a staff user (`ai.conversations.manage`). 201 expected; 429/402/403 are counted. */
export function aiRestTurn(session, step) {
  const p = authWrite(session, { step });
  p.responseCallback = http.expectedStatuses({ min: 200, max: 299 }, 402, 403, 429);
  const res = http.post(`${BASE}/api/v1/ai/orchestrator/message`, JSON.stringify({
    channel: 'DASHBOARD',
    content: `Load test message ${__VU}-${__ITER || 0}: what are today's opening hours?`,
    idempotencyKey: `lt-ai-${__VU}-${__ITER || 0}-${Math.floor(Math.random() * 1e9)}`,
  }), p);
  observe(res, 'ai:rest', step);
  let ok = res.status === 201;
  if (ok) { try { const b = res.json(); ok = !!b.aiConversationId && (b.handedOver === true || !!b.reply); } catch (e) { ok = false; } }
  if (res.status === 429) aiTurnRateLimited.add(1, { step, via: 'rest' });
  businessErrors.add(!ok && res.status !== 429, { step });
  return res;
}

/** Mints (or reuses) a guest identity; the token exists ONLY in the guest_token cookie. */
export function guestToken() {
  const res = http.post(`${BASE}/api/v1/public/guest/session`, null, { tags: { name: 'ai/guest-session' } });
  observe(res, 'ai:guest-session', 'guest');
  if (res.status !== 200) return null;
  const c = http.cookieJar().cookiesForURL(`${BASE}/`);
  return c.guest_token ? c.guest_token[0] : null;
}

/**
 * One realtime turn: connect, join the /ai namespace, send one message, wait for
 * ai:done. `token` is a guest token or a staff access token.
 */
export function aiSocketTurn(token, step, content) {
  if (!token) return null;
  let sentAt = 0;
  let finished = false;
  const jar = new http.CookieJar(); // empty: no Cookie header, no Origin => admitted
  const res = ws.connect(WS_URL, { jar, tags: { step, name: 'ws/ai' } }, (socket) => {
    const finish = (counter, tags) => {
      if (finished) return;
      finished = true;
      counter.add(1, Object.assign({ step }, tags || {}));
      socket.close();
    };
    socket.on('message', (m) => {
      if (m.charAt(0) === '0') {
        socket.send(`40/ai,${JSON.stringify({ token })}`);
      } else if (m === '2') {
        socket.send('3');
      } else if (m.indexOf('42/ai,["ai:connected"') === 0) {
        sentAt = Date.now();
        socket.send(`42/ai,${JSON.stringify(['ai:message', { content: content || 'hello, what are your opening hours?', channel: 'WEBSITE' }])}`);
      } else if (m.indexOf('42/ai,["ai:done"') === 0) {
        aiTurnLatency.add(Date.now() - sentAt, { step });
        finish(aiTurnDone);
      } else if (m.indexOf('42/ai,["ai:error"') === 0) {
        if (m.indexOf('RATE_LIMITED') !== -1) finish(aiTurnRateLimited, { via: 'ws' });
        else finish(aiTurnError, { via: 'ws' });
      }
    });
    socket.on('error', () => finish(aiTurnError, { via: 'ws-transport' }));
    socket.setTimeout(() => finish(aiTurnError, { via: 'timeout' }), TURN_TIMEOUT_MS);
  });
  if (!res || res.status !== 101) wsConnectFail.add(1, { step });
  businessErrors.add(!finished || !res || res.status !== 101, { step });
  return res;
}

/** Guest widget visitor: mint a guest, then one realtime turn. */
export function guestAiTurn(step) {
  return aiSocketTurn(guestToken(), step);
}
