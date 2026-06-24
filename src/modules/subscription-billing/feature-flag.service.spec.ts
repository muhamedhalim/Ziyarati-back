import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { FeatureFlagService } from './feature-flag.service';
import { FeatureFlag } from '../../entities/SaaS-Core/FeatureFlag';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;
  let flags: MockRepository;

  beforeEach(async () => {
    flags = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [FeatureFlagService, { provide: getRepositoryToken(FeatureFlag), useValue: flags }],
    }).compile();
    service = moduleRef.get(FeatureFlagService);
  });

  afterEach(() => jest.clearAllMocks());

  it('lists tenant flags', async () => {
    flags.find.mockResolvedValueOnce([{ feature_key: 'ai' }]);
    await expect(service.list(TENANT)).resolves.toHaveLength(1);
  });

  it('set creates a new flag when none exists', async () => {
    flags.findOne.mockResolvedValueOnce(null);
    flags.create.mockReturnValueOnce({ feature_key: 'ai', is_enabled: true });
    flags.save.mockImplementationOnce(async (f: any) => f);
    const res = await service.set(TENANT, 'ai', true);
    expect(res).toEqual(expect.objectContaining({ is_enabled: true }));
  });

  it('set updates an existing flag', async () => {
    flags.findOne.mockResolvedValueOnce({ feature_key: 'ai', is_enabled: false });
    flags.save.mockImplementationOnce(async (f: any) => f);
    const res = await service.set(TENANT, 'ai', true);
    expect(res.is_enabled).toBe(true);
    expect(flags.create).not.toHaveBeenCalled();
  });

  it('isEnabled defaults to false when the flag is missing', async () => {
    flags.findOne.mockResolvedValueOnce(null);
    expect(await service.isEnabled(TENANT, 'ai')).toBe(false);
  });

  it('assertEnabled passes when enabled and throws 403 when not', async () => {
    flags.findOne.mockResolvedValueOnce({ is_enabled: true });
    await expect(service.assertEnabled(TENANT, 'ai')).resolves.toBeUndefined();

    flags.findOne.mockResolvedValueOnce(null);
    await expect(service.assertEnabled(TENANT, 'ai')).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });
});
