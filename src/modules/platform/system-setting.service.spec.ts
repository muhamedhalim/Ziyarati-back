import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SystemSettingService } from './system-setting.service';
import { SystemSetting } from '../../entities/System&Lookup/SystemSetting';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

describe('SystemSettingService', () => {
  let service: SystemSettingService;
  let settings: MockRepository;

  beforeEach(async () => {
    settings = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [SystemSettingService, { provide: getRepositoryToken(SystemSetting), useValue: settings }],
    }).compile();
    service = moduleRef.get(SystemSettingService);
  });

  afterEach(() => jest.clearAllMocks());

  it('creates a setting with a unique key', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    settings.save.mockResolvedValueOnce({ id: 's1' });
    await expect(service.create({ key: 'k', value: { a: 1 } } as any)).resolves.toEqual({ id: 's1' });
  });

  it('rejects a duplicate key', async () => {
    settings.findOne.mockResolvedValueOnce({ id: 'existing' });
    await expect(service.create({ key: 'k' } as any)).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });

  it('updates value and re-checks key uniqueness on rename', async () => {
    settings.findOne
      .mockResolvedValueOnce({ id: 's1', key: 'old', value: {} }) // get
      .mockResolvedValueOnce(null); // key unique
    settings.save.mockImplementationOnce(async (s: any) => s);
    const res = await service.update('s1', { key: 'new', value: { b: 2 } } as any);
    expect(res).toEqual(expect.objectContaining({ key: 'new', value: { b: 2 } }));
  });

  it('get throws when the setting does not exist', async () => {
    settings.findOne.mockResolvedValueOnce(null);
    await expect(service.get('x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('removes and lists settings', async () => {
    settings.findOne.mockResolvedValueOnce({ id: 's1' });
    await expect(service.remove('s1')).resolves.toEqual({ id: 's1', deleted: true });

    settings.findAndCount.mockResolvedValueOnce([[{ id: 's1' }], 1]);
    await expect(service.list({ page: 1, limit: 10, key: 'bil' } as any)).resolves.toMatchObject({ total: 1 });
  });
});
