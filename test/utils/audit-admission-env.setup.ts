/**
 * Lowers the inbound-webhook admission budgets BEFORE AppModule is first
 * required in the audit-admission spec (same pattern as
 * integration-rate-limit-env.setup.ts).
 *
 *   signed events:   5/min per connection, 50/min per tenant
 *   unsigned noise:  4/min per source IP, 50/min per connection, 500/min per tenant
 */
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_CONNECTION = '5';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_TENANT = '50';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_IP = '4';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_CONNECTION = '50';
process.env.INTEGRATION_RL_INBOUND_WEBHOOK_UNSIGNED_TENANT = '500';

export {};
