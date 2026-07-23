import { IntegrationConnectionService } from './integration-connection.service';
import { CONNECTION_STATUS, HEALTH_STATE } from '../integration-platform.constants';

function repoMock(connection: any) {
  return {
    findOne: jest.fn().mockResolvedValue(connection),
  } as any;
}
const encryption = {} as any;
const audit = { record: jest.fn() } as any;
const providers = { capabilitiesOf: jest.fn(), healthCheck: jest.fn() } as any;

const conn = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  status: CONNECTION_STATUS.ACTIVE,
  consecutive_failures: 0,
  last_success_at: new Date(),
  last_error: null,
  last_error_at: null,
  last_latency_ms: 12,
  credentials_ciphertext: 'CIPHERTEXT_SENTINEL_XYZ',
  auth_type: 'api_key',
  sync_direction: 'bidirectional',
  ...over,
});

async function stateOf(over: Record<string, unknown>): Promise<string> {
  const svc = new IntegrationConnectionService(repoMock(conn(over)), encryption, audit, providers);
  const h = await svc.health('t1', 'c1');
  return h.state;
}

describe('IntegrationConnectionService — derived health (never row existence)', () => {
  it('inactive/disconnected → disabled', async () => {
    expect(await stateOf({ status: CONNECTION_STATUS.INACTIVE })).toBe(HEALTH_STATE.DISABLED);
    expect(await stateOf({ status: CONNECTION_STATUS.DISCONNECTED })).toBe(HEALTH_STATE.DISABLED);
  });

  it('active + recent success + no failures → healthy', async () => {
    expect(await stateOf({})).toBe(HEALTH_STATE.HEALTHY);
  });

  it('active but never yet succeeded → degraded (not healthy)', async () => {
    expect(await stateOf({ last_success_at: null })).toBe(HEALTH_STATE.DEGRADED);
  });

  it('active with some consecutive failures → degraded', async () => {
    expect(await stateOf({ consecutive_failures: 2 })).toBe(HEALTH_STATE.DEGRADED);
  });

  it('active with many consecutive failures → offline', async () => {
    expect(await stateOf({ consecutive_failures: 5 })).toBe(HEALTH_STATE.OFFLINE);
  });

  it('active but last success is stale (> 1 day) → offline', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    expect(await stateOf({ last_success_at: twoDaysAgo })).toBe(HEALTH_STATE.OFFLINE);
  });

  it('health view never leaks the credential ciphertext', async () => {
    const svc = new IntegrationConnectionService(repoMock(conn()), encryption, audit, providers);
    const h = await svc.health('t1', 'c1');
    expect(JSON.stringify(h)).not.toContain('CIPHERTEXT_SENTINEL_XYZ');
    expect(h.credential).toEqual({ present: true, authType: 'api_key' });
  });
});
