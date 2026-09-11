import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { StaffScopeService } from './staff-scope.service';
import { StaffProfile } from '../../entities/Staff/StaffProfile';
import { AppRedisService } from '../../queue/app-redis.service';
import {
  createMockRepository,
  MockRepository,
} from '../../../test/utils/mock-factories';

const TENANT = 't1';
const USER = 'u1';
const STAFF_ID = 'staff-1';

describe('StaffScopeService', () => {
  let service: StaffScopeService;
  let staffProfiles: MockRepository;
  let redis: { application: { get: jest.Mock; set: jest.Mock } };

  beforeEach(async () => {
    staffProfiles = createMockRepository();
    redis = {
      application: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        StaffScopeService,
        { provide: getRepositoryToken(StaffProfile), useValue: staffProfiles },
        { provide: AppRedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(StaffScopeService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── The rule ─────────────────────────────────────────────────────────────

  it("resolves the caller's own StaffProfile id, scoped by (userId, tenantId)", async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    const result = await service.resolveOwnStaffId(TENANT, USER);

    expect(result).toBe(STAFF_ID);
    expect(staffProfiles.findOne).toHaveBeenCalledWith({
      where: { user: { id: USER }, tenant: { id: TENANT } },
      select: { id: true },
    });
  });

  it('returns null (never throws) when the caller owns no StaffProfile — e.g. an Owner/Manager account', async () => {
    staffProfiles.findOne.mockResolvedValueOnce(null);

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBeNull();
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  it('caches the resolved id under a TENANT-qualified key, so a second call skips the database', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:${USER}`,
      STAFF_ID,
      'EX',
      expect.any(Number),
    );

    redis.application.get.mockResolvedValueOnce(STAFF_ID);
    staffProfiles.findOne.mockClear();
    const second = await service.resolveOwnStaffId(TENANT, USER);
    expect(second).toBe(STAFF_ID);
    expect(staffProfiles.findOne).not.toHaveBeenCalled();
  });

  it("caches a 'no profile' answer too — a cache hit of the empty-string sentinel resolves to null without a database read", async () => {
    staffProfiles.findOne.mockResolvedValueOnce(null);
    await service.resolveOwnStaffId(TENANT, USER);

    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:${USER}`,
      '',
      'EX',
      expect.any(Number),
    );

    redis.application.get.mockResolvedValueOnce('');
    staffProfiles.findOne.mockClear();
    const second = await service.resolveOwnStaffId(TENANT, USER);
    expect(second).toBeNull();
    expect(staffProfiles.findOne).not.toHaveBeenCalled();
  });

  it('falls through to the database when Redis errors on read — a cache hiccup is never a 500', async () => {
    redis.application.get.mockRejectedValueOnce(new Error('down'));
    redis.application.set.mockRejectedValueOnce(new Error('down'));
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBe(STAFF_ID);
  });

  it('still returns the resolved value when Redis errors on write', async () => {
    redis.application.set.mockRejectedValueOnce(new Error('down'));
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });

    await expect(service.resolveOwnStaffId(TENANT, USER)).resolves.toBe(STAFF_ID);
  });

  it('a different user gets a distinct cache key — no cross-user bleed', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    staffProfiles.findOne.mockResolvedValueOnce({ id: 'staff-2' });
    const other = await service.resolveOwnStaffId(TENANT, 'u2');

    expect(other).toBe('staff-2');
    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:${TENANT}:u2`,
      'staff-2',
      'EX',
      expect.any(Number),
    );
  });

  it('a different tenant gets a distinct cache key — no cross-tenant bleed', async () => {
    staffProfiles.findOne.mockResolvedValueOnce({ id: STAFF_ID });
    await service.resolveOwnStaffId(TENANT, USER);

    staffProfiles.findOne.mockResolvedValueOnce({ id: 'staff-2' });
    const other = await service.resolveOwnStaffId('t2', USER);

    expect(other).toBe('staff-2');
    expect(redis.application.set).toHaveBeenCalledWith(
      `staff-profile:t2:${USER}`,
      'staff-2',
      'EX',
      expect.any(Number),
    );
  });
});
