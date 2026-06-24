import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerFileService } from './customer-file.service';
import { CustomerService } from './customer.service';
import { CustomerFile } from '../../entities/CRM/CustomerFile';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerFileService', () => {
  let service: CustomerFileService;
  let files: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    files = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerFileService,
        { provide: getRepositoryToken(CustomerFile), useValue: files },
        { provide: CustomerService, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(CustomerFileService);
  });

  afterEach(() => jest.clearAllMocks());

  it('stores file metadata with the uploader', async () => {
    files.save.mockResolvedValueOnce({ id: 'f1' });
    await service.upload(TENANT, CUSTOMER, { file_url: 'u', file_name: 'n' } as any, 'user-1');
    const created = files.create.mock.calls[0][0];
    expect(created.uploaded_by).toEqual({ id: 'user-1' });
  });

  it('getMetadata throws for an unknown file', async () => {
    files.findOne.mockResolvedValueOnce(null);
    await expect(service.getMetadata(TENANT, CUSTOMER, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('removes a file', async () => {
    files.findOne.mockResolvedValueOnce({ id: 'f1' });
    await expect(service.remove(TENANT, CUSTOMER, 'f1')).resolves.toEqual({ id: 'f1', deleted: true });
  });

  it('lists files with pagination', async () => {
    files.findAndCount.mockResolvedValueOnce([[{ id: 'f1' }], 1]);
    await expect(service.list(TENANT, CUSTOMER, { page: 1, limit: 10 } as any)).resolves.toMatchObject({ total: 1 });
  });
});
