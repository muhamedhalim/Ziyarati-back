/**
 * Tiny, pure builders for k6 scenario definitions (no k6 imports, so any scenario
 * file may use them at init time).
 */
export const num = (k, d) => (__ENV[k] === undefined || __ENV[k] === '' ? d : Number(__ENV[k]));
export const str = (k, d) => (__ENV[k] === undefined || __ENV[k] === '' ? d : __ENV[k]);

export function secs(s) {
  const m = /^(\d+)(s|m|h)$/.exec(String(s));
  if (!m) return Number(s) || 0;
  return Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
}

/** constant-arrival-rate: OFFERED load is fixed regardless of latency (open model). */
export function arrival(exec, rate, duration, tags, extra) {
  const r = Math.max(0.1, rate);
  const pre = num('LT_PREALLOC', Math.max(10, Math.ceil(r * 2)));
  return Object.assign({
    executor: 'constant-arrival-rate',
    rate: r, timeUnit: '1s', duration,
    preAllocatedVUs: pre,
    maxVUs: num('LT_MAXVUS', Math.max(pre, Math.ceil(r * 10))),
    exec,
    gracefulStop: '30s',
    tags: Object.assign({ scenario_kind: 'open' }, tags || {}),
  }, extra || {});
}

/** constant-vus: a closed population of N users. */
export function constantVus(exec, vus, duration, tags, extra) {
  return Object.assign({
    executor: 'constant-vus', vus, duration, exec, gracefulStop: '30s',
    tags: Object.assign({ scenario_kind: 'closed' }, tags || {}),
  }, extra || {});
}

/** ramping-vus through [{duration,target}] stages. */
export function rampVus(exec, stages, tags, extra) {
  return Object.assign({
    executor: 'ramping-vus', startVUs: 0, stages, exec,
    gracefulRampDown: '30s', gracefulStop: '30s',
    tags: Object.assign({ scenario_kind: 'closed' }, tags || {}),
  }, extra || {});
}

/** Offsets a scenario so a group of scenarios can run back to back. */
export function startAt(scenario, seconds) {
  return Object.assign({}, scenario, { startTime: `${seconds}s` });
}
