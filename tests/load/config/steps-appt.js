/**
 * Registers one latency-histogram step per appointment-stress mode so the report separates
 * throughput / lifecycle / same-slot / same-doctor / hot-branch / multi-tenant. Import this
 * FIRST in the scenario (helpers/buckets.js reads LT_STEPS at import time).
 */
const ADD = 'a_throughput,a_lifecycle,a_sameslot,a_samedoctor,a_hotbranch,a_multitenant';
__ENV.LT_STEPS = __ENV.LT_STEPS ? `${__ENV.LT_STEPS},${ADD}` : ADD;
