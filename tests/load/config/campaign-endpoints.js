/**
 * Endpoint labels emitted by the campaign flows (the pre-campaign set lives in
 * thresholds.js). The mergeable-histogram registry (helpers/buckets.js)
 * pre-registers one counter family per label, because k6 metrics can only be
 * created in the init context and an unregistered label simply gets no
 * per-endpoint histogram (it is still recorded in the normal Trend).
 */
export const CAMPAIGN_ENDPOINTS = [
  'queue:list', 'queue:branches', 'queue:check-in', 'queue:call', 'queue:start', 'queue:complete',
  'mkt:specialties', 'mkt:specialty', 'mkt:doctors', 'mkt:doctor', 'mkt:avatar',
  'mkt:clinic', 'mkt:service', 'mkt:services',
  'journey:summary', 'journey:breakdown',
  'doctor:appointments', 'staff:me', 'staff:me:schedules', 'staff:me:time-off',
  'partner:me', 'partner:appointments', 'partner:customers', 'partner:services',
  'partner:staff', 'partner:availability', 'partner:customers:upsert',
  'partner:services:upsert', 'partner:inbound', 'partner:inbound:dup',
  'pay:resolve', 'pay:checkout', 'pay:return', 'pay:webhook',
  'billing:checkout', 'refund:create',
  'wa:status', 'wa:status-dup', 'wa:message',
  'ai:rest', 'ai:guest-session',
  'auth:me', 'auth:refresh', 'auth:logout', 'auth:login:bad', 'auth:login:lockout',
  'platform:finance:kpis', 'platform:finance:transactions', 'platform:finance:invoices',
  'platform:sales:overview', 'platform:sales:employees',
  'appointments:reschedule', 'appointments:cancel',
  'crm:search:code', 'crm:search:email', 'crm:search:phone', 'crm:search:prefix',
  'crm:search:name', 'crm:search:broad', 'crm:search:deep',
  'services:import:preview',
  'health:raw',
];

/**
 * The per-endpoint histograms kept when LT_EP_BUCKETS=hot (the 20K stages), to
 * bound VU init cost: every VU registers every counter, and 20,000 VUs x ~800
 * counters is not free. The calibration run measures the real cost.
 */
export const HOT_ENDPOINTS = [
  'dashboard', 'appointments:list', 'availability:windows', 'appointments:create',
  'crm:search:term', 'staff:list', 'notifications:unread', 'activity:list',
  'queue:list', 'queue:check-in', 'journey:summary', 'mkt:clinic', 'mkt:doctors',
  'pay:checkout', 'pay:webhook', 'partner:appointments', 'partner:inbound',
  'ai:rest', 'auth:login', 'auth:refresh', 'public:booking:availability',
  'public:booking:session', 'public:cities', 'health:raw',
];
