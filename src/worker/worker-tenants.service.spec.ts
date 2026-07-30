import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WorkerTenantsService } from './worker-tenants.service';
import { Tenant } from '../entities/SaaS-Core/Tenant';
import { TenantApprovalStatus } from '../entities/enums';
import {
  createMockRepository,
  MockRepository,
} from '../../test/utils/mock-factories';

describe('WorkerTenantsService', () => {
  let service: WorkerTenantsService;
  let tenants: MockRepository;

  beforeEach(async () => {
    tenants = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WorkerTenantsService,
        { provide: getRepositoryToken(Tenant), useValue: tenants },
      ],
    }).compile();
    service = moduleRef.get(WorkerTenantsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns the ids of APPROVED, active tenants', async () => {
    tenants.find.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
    const ids = await service.activeTenantIds();
    expect(ids).toEqual(['t1', 't2']);
    expect(tenants.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          approval_status: TenantApprovalStatus.APPROVED,
          is_active: true,
        },
      }),
    );
  });

  it('returns an empty list when no tenants are active', async () => {
    tenants.find.mockResolvedValueOnce([]);
    await expect(service.activeTenantIds()).resolves.toEqual([]);
  });

  describe('activeTenantIdsPage (M7 — bounded pagination for sweep fan-outs)', () => {
    it('passes skip/take/order through to the repository and returns just the ids', async () => {
      tenants.find.mockResolvedValueOnce([{ id: 't1' }, { id: 't2' }]);
      const ids = await service.activeTenantIdsPage(500, 500);
      expect(ids).toEqual(['t1', 't2']);
      expect(tenants.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            approval_status: TenantApprovalStatus.APPROVED,
            is_active: true,
          },
          skip: 500,
          take: 500,
          order: { id: 'ASC' },
        }),
      );
    });

    it('returns an empty page past the end of the tenant list', async () => {
      tenants.find.mockResolvedValueOnce([]);
      await expect(service.activeTenantIdsPage(10_000, 500)).resolves.toEqual(
        [],
      );
    });
  });
});
