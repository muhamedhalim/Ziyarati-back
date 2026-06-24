import { DataSource } from 'typeorm';

import { FreeAccessOverrideService } from './free-access-override.service';
import { ErrorCode } from '../../common/errors';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'ov-1',
  tenant_id: 't1',
  granted_by: 'admin-1',
  reason: 'partner',
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: null,
  status: 'ACTIVE',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: null,
  ...overrides,
});

describe('FreeAccessOverrideService', () => {
  let service: FreeAccessOverrideService;
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn();
    service = new FreeAccessOverrideService({ query } as unknown as DataSource);
  });

  afterEach(() => jest.clearAllMocks());

  it('getActive maps the active override row', async () => {
    query.mockResolvedValueOnce([row()]);
    const active = await service.getActive('t1');
    expect(active).toMatchObject({ id: 'ov-1', tenant_id: 't1', status: 'ACTIVE' });
  });

  it('hasActive is false when there is no active override', async () => {
    query.mockResolvedValueOnce([]);
    expect(await service.hasActive('t1')).toBe(false);
  });

  it('grant inserts a new override when none is active', async () => {
    query.mockResolvedValueOnce([]); // hasActive → getActive → none
    query.mockResolvedValueOnce([row()]); // INSERT RETURNING
    const granted = await service.grant('t1', { grantedBy: 'admin-1', durationDays: 30 });
    expect(granted.id).toBe('ov-1');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('grant rejects when an override is already active', async () => {
    query.mockResolvedValueOnce([row()]); // hasActive → active
    await expect(service.grant('t1', {})).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('extend throws when there is no active override', async () => {
    query.mockResolvedValueOnce([]); // getActive → none
    await expect(service.extend('t1', 30)).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('extend updates the active override', async () => {
    query.mockResolvedValueOnce([row()]); // getActive
    query.mockResolvedValueOnce([row({ ends_at: '2026-12-31T00:00:00Z' })]); // UPDATE RETURNING
    const res = await service.extend('t1', 30);
    expect(res.ends_at).toEqual(new Date('2026-12-31T00:00:00Z'));
  });

  it('revoke succeeds when a row was affected', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(service.revoke('t1')).resolves.toEqual({ revoked: true });
  });

  it('revoke throws when nothing was active', async () => {
    query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(service.revoke('t1')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
