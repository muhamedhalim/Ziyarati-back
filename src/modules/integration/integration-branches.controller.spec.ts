import { IntegrationBranchesController } from './integration-branches.controller';
import { toIntegrationBranch } from './integration.mappers';
import { AppError, ErrorCode } from '../../common/errors';

const row = (n: number) =>
  ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    name: `Branch ${n}`,
    timezone: 'Asia/Riyadh',
    is_active: n !== 3,
    // fields that must never leave the platform:
    address: 'Secret street 1',
    phone: '+966500000000',
    whatsapp_phone: '+966511111111',
    city_id: 'city-1',
    city: { id: 'city-1', name: 'Riyadh' },
    tenant: { id: 'tenant-A' },
    created_at: new Date(),
  }) as never;

describe('toIntegrationBranch — strict allowlist', () => {
  it('returns only id, name, timezone, isActive', () => {
    expect(toIntegrationBranch(row(1))).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Branch 1',
      timezone: 'Asia/Riyadh',
      isActive: true,
    });
  });
});

describe('IntegrationBranchesController', () => {
  function build() {
    const branches = {
      findAll: jest.fn().mockResolvedValue([row(1), row(2), row(3)]),
      findOne: jest.fn(async (_t: string, id: string) => {
        if (id.endsWith('1')) return row(1);
        throw new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' });
      }),
    };
    const ctx = { requireTenantId: jest.fn().mockReturnValue('tenant-A') };
    return { c: new IntegrationBranchesController(branches as never, ctx as never), branches };
  }

  it('lists only the key tenant\'s branches, projected, paginated', async () => {
    const { c, branches } = build();
    const res = await c.list({ page: 1, limit: 2 });
    expect(branches.findAll).toHaveBeenCalledWith('tenant-A');
    expect(res.total).toBe(3);
    expect(res.data).toHaveLength(2);
    expect(Object.keys(res.data[0]).sort()).toEqual(['id', 'isActive', 'name', 'timezone']);
    const page2 = await c.list({ page: 2, limit: 2 });
    expect(page2.data).toHaveLength(1);
    expect((await c.list({ page: 9, limit: 2 })).data).toEqual([]);
  });

  it('detail is tenant-scoped; an unknown / foreign id is 404', async () => {
    const { c, branches } = build();
    await expect(c.get('00000000-0000-4000-8000-000000000001')).resolves.toMatchObject({ name: 'Branch 1' });
    expect(branches.findOne).toHaveBeenCalledWith('tenant-A', '00000000-0000-4000-8000-000000000001');
    await expect(c.get('00000000-0000-4000-8000-000000000009')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });
});
