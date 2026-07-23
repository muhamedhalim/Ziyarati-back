import { ErrorCode } from '../../../common/errors';
import { INTEGRATION_RESOURCE } from '../integration-platform.constants';
import { IntegrationIdMapService } from './integration-id-map.service';

function repoMock(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findOne: jest.fn(),
    save: jest.fn((x) => Promise.resolve({ id: 'm1', ...x })),
    create: jest.fn((x) => x),
    findAndCount: jest.fn(),
    ...overrides,
  } as any;
}

const R = INTEGRATION_RESOURCE.CUSTOMER;

describe('IntegrationIdMapService.link', () => {
  const tenantId = 't1';
  const connectionId = 'c1';

  it('creates a new mapping when none exists', async () => {
    const repo = repoMock({ findOne: jest.fn().mockResolvedValue(null) });
    const svc = new IntegrationIdMapService(repo);
    const m = await svc.link(tenantId, connectionId, R, 'EXT-1', 'int-1');
    expect(m.id).toBe('m1');
    expect(repo.save).toHaveBeenCalled();
  });

  it('is idempotent when the same external→internal mapping already exists', async () => {
    const existing = { id: 'm-existing', internal_resource_id: 'int-1', external_id: 'EXT-1' };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValueOnce(existing) });
    const svc = new IntegrationIdMapService(repo);
    const m = await svc.link(tenantId, connectionId, R, 'EXT-1', 'int-1');
    expect(m).toBe(existing);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('rejects mapping an external id to a DIFFERENT internal record', async () => {
    const existing = { id: 'm-existing', internal_resource_id: 'int-OTHER', external_id: 'EXT-1' };
    const repo = repoMock({ findOne: jest.fn().mockResolvedValueOnce(existing) });
    const svc = new IntegrationIdMapService(repo);
    await expect(svc.link(tenantId, connectionId, R, 'EXT-1', 'int-1')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });

  it('rejects mapping an internal record to a DIFFERENT external id', async () => {
    const repo = repoMock({
      findOne: jest
        .fn()
        // byExternal → none
        .mockResolvedValueOnce(null)
        // byInternal → already mapped to another external id
        .mockResolvedValueOnce({ id: 'm-x', internal_resource_id: 'int-1', external_id: 'EXT-OTHER' }),
    });
    const svc = new IntegrationIdMapService(repo);
    await expect(svc.link(tenantId, connectionId, R, 'EXT-1', 'int-1')).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
  });
});
