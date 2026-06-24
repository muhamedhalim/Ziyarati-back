import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BillingModeService } from './billing-mode.service';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { BillingMode } from './platform-billing.constants';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('BillingModeService', () => {
  let service: BillingModeService;
  let settings: MockRepository;

  beforeEach(async () => {
    settings = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [BillingModeService, { provide: getRepositoryToken(SystemSetting), useValue: settings }],
    }).compile();
    service = moduleRef.get(BillingModeService);
  });

  afterEach(() => jest.clearAllMocks());

  it('defaults to FREE when never configured', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    expect(await service.get()).toBe(BillingMode.FREE);
  });

  it('reads PAID mode and reports isPaidMode true', async () => {
    settings.findOne.mockResolvedValueOnce({ value: { mode: BillingMode.PAID } });
    expect(await service.isPaidMode()).toBe(true);
  });

  it('caches the mode (a second read does not hit the DB)', async () => {
    settings.findOne.mockResolvedValueOnce({ value: { mode: BillingMode.PAID } });
    await service.get();
    await service.get();
    expect(settings.findOne).toHaveBeenCalledTimes(1);
  });

  it('set() upserts a new setting and refreshes the cache immediately', async () => {
    settings.findOne.mockResolvedValueOnce(null); // no existing setting
    const res = await service.set(BillingMode.PAID);
    expect(res).toEqual({ mode: BillingMode.PAID });
    expect(settings.save).toHaveBeenCalled();
    // cache primed → get() returns without another DB read
    expect(await service.get()).toBe(BillingMode.PAID);
    expect(settings.findOne).toHaveBeenCalledTimes(1);
  });

  it('set() updates an existing setting row', async () => {
    settings.findOne.mockResolvedValueOnce({ key: 'billing.mode', value: { mode: BillingMode.FREE } });
    await service.set(BillingMode.PAID);
    const saved = settings.save.mock.calls[0][0];
    expect(saved.value).toEqual({ mode: BillingMode.PAID });
  });
});
