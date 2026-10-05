// Fake HTTP layer: records every request and answers with plausible JSON so flows run end to end.
const S = globalThis.__LT;
const ID = '11111111-1111-4111-8111-111111111111';
const GENERIC = {
  id: ID, data: [{ id: ID }], total: 1, page: 1, limit: 20, count: 3, items: [{ id: ID }], state: 'payable', available: true,
  windows: [{ startAt: '2030-01-01T05:00:00Z' }], slots: [{ startAt: '2030-01-01T05:00:00Z' }], services: [{ id: ID }], doctors: [{ id: ID }],
  branches: [{ id: ID }], user: { id: ID, tenantId: ID, permissions: ['analytics.reports.read', 'audit.read'] }, customers: 5,
  scope: { appointments: 'ALL' }, range: { from: 'a', to: 'b' }, counts: {}, asOf: 'x', outcome: 'created', status: 'redirect',
  redirectUrl: 'https://checkout.tap.test/chg_x', aiConversationId: ID, reply: { id: ID }, handedOver: false, clinic: { id: ID }, service: { id: ID },
  guestId: ID, accepted: true, matched: true, received: true, eventId: 'e', keyId: ID, subscriptionStatus: 'ACTIVE',
};
const RULES = [
  [/\/public\/discovery\/cities$/, 'GET', 200, () => [{ id: ID }]],
  [/\/public\/discovery\/clinics\?/, 'GET', 200, () => [{ id: ID }]],
  [/\/public\/discovery\/clinics\/[^/?]+$/, 'GET', 200, () => ({ branches: [{ id: ID }] })],
  [/\/public\/discovery\/specialties$/, 'GET', 200, () => [{ slug: 's' }]],
  [/\/services\/lookup|\/branches$|\/activity\/actions|\/crm\/tags|\/queue\/branches/, 'GET', 200, () => [{ id: ID }]],
  [/\/queue\/check-in$/, 'POST', 201, () => ({ id: ID, state: 'WAITING' })],
  [/\/appointments$/, 'POST', 201, () => ({ id: ID })],
  [/\/integrations\/inbound\//, 'POST', 202, () => ({ received: true, eventId: 'e', status: 'accepted' })],
  [/\/ai\/orchestrator\/message$/, 'POST', 201, () => ({ aiConversationId: ID, reply: { id: ID }, handedOver: false })],
  [/\/refunds$/, 'POST', 201, () => ({ id: ID })],
  [/\/auth\/login$/, 'POST', 200, () => ({ user: { id: ID, tenantId: ID, permissions: ['audit.read'] } })],
  [/\/auth\/logout$/, 'POST', 204, () => ({})],
];
function respond(method, url) {
  const rule = RULES.find(([re, m]) => re.test(url) && m === method);
  const status = rule ? rule[2] : 200;
  const body = rule ? rule[3]() : GENERIC;
  const raw = JSON.stringify(body);
  S.requests.push({ method, url });
  return { status, body: raw, headers: {}, url, timings: { duration: 12 }, cookies: {}, json: () => JSON.parse(raw) };
}
const norm = (u) => String(u).replace(/^https?:\/\/[^/]+/, '');
const http = {
  get: (url) => respond('GET', norm(url)),
  post: (url, body, params) => {
    if (params && params.headers && typeof params.headers !== 'object') throw new Error('bad headers');
    return respond('POST', norm(url));
  },
  put: (url) => respond('PUT', norm(url)),
  del: (url) => respond('DELETE', norm(url)),
  batch: (reqs) => reqs.map((r) => (Array.isArray(r) ? respond(r[0], norm(r[1])) : respond(r.method || 'GET', norm(r.url)))),
  file: (data, filename, contentType) => ({ data, filename, content_type: contentType }),
  expectedStatuses: (...a) => ({ expected: a }),
  cookieJar: () => ({ cookiesForURL: () => ({ access_token: ['AT'], csrf_token: ['CT'], guest_token: ['GT'] }) }),
  CookieJar: class { cookiesForURL() { return { csrf_token: ['CT'], guest_token: ['GT'] }; } },
};
export default http;
