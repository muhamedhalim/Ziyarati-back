import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerFileService } from './customer-file.service';
import { CustomerService } from './customer.service';
import { StorageService } from '../storage/storage.service';
import { CustomerFile } from '../../entities/CRM/CustomerFile';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerFileService', () => {
  let service: CustomerFileService;
  let files: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };
  let storage: {
    upload: jest.Mock;
    getSignedDownloadUrl: jest.Mock;
    deleteObject: jest.Mock;
  };

  const uploadInput = {
    originalName: 'lab-result.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.4'),
  };

  beforeEach(async () => {
    files = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }) };
    storage = {
      upload: jest.fn().mockResolvedValue({
        storageKey: `${TENANT}/customer-file/x.pdf`,
        filename: 'lab-result.pdf',
        mimeType: 'application/pdf',
        size: 1024,
        sha256: 'deadbeef',
      }),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example.com/file'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerFileService,
        { provide: getRepositoryToken(CustomerFile), useValue: files },
        { provide: CustomerService, useValue: customers },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = moduleRef.get(CustomerFileService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('upload', () => {
    it('streams the file through StorageService and stores the returned key', async () => {
      files.save.mockResolvedValueOnce({
        id: 'f1',
        storage_key: `${TENANT}/customer-file/x.pdf`,
      });

      await service.upload(TENANT, CUSTOMER, uploadInput, 'user-1');

      expect(storage.upload).toHaveBeenCalledWith({
        tenantId: TENANT,
        docType: 'customer-file',
        originalName: uploadInput.originalName,
        mimeType: uploadInput.mimeType,
        size: uploadInput.size,
        buffer: uploadInput.buffer,
      });
      const created = files.create.mock.calls[0][0];
      expect(created.uploaded_by).toEqual({ id: 'user-1' });
      expect(created.storage_key).toBe(`${TENANT}/customer-file/x.pdf`);
      expect(created.file_name).toBe('lab-result.pdf');
    });

    it('uses the provided fileName override instead of the original filename', async () => {
      files.save.mockResolvedValueOnce({ id: 'f1', storage_key: 'k' });

      await service.upload(
        TENANT,
        CUSTOMER,
        { ...uploadInput, fileName: 'Lab result — June' },
        'user-1',
      );

      const created = files.create.mock.calls[0][0];
      expect(created.file_name).toBe('Lab result — June');
    });

    it('resolves a signed URL for the newly-created file', async () => {
      files.save.mockResolvedValueOnce({
        id: 'f1',
        storage_key: `${TENANT}/customer-file/x.pdf`,
      });

      const result = await service.upload(TENANT, CUSTOMER, uploadInput, 'user-1');

      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith(`${TENANT}/customer-file/x.pdf`);
      expect(result.file_url).toBe('https://signed.example.com/file');
    });
  });

  describe('getMetadata', () => {
    it('throws for an unknown file', async () => {
      files.findOne.mockResolvedValueOnce(null);
      await expect(service.getMetadata(TENANT, CUSTOMER, 'x')).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('resolves a signed URL when a storage_key is present', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: 'k1' });
      const result = await service.getMetadata(TENANT, CUSTOMER, 'f1');
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('k1');
      expect(result.file_url).toBe('https://signed.example.com/file');
    });

    it('does not call storage when there is no storage_key (legacy row)', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: null, file_url: 'https://legacy.example.com/x' });
      const result = await service.getMetadata(TENANT, CUSTOMER, 'f1');
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
      expect(result.file_url).toBe('https://legacy.example.com/x');
    });
  });

  describe('remove', () => {
    it('removes the row and best-effort deletes the R2 object', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: 'k1' });
      await expect(service.remove(TENANT, CUSTOMER, 'f1')).resolves.toEqual({ id: 'f1', deleted: true });
      expect(storage.deleteObject).toHaveBeenCalledWith('k1');
    });

    it('does not call storage.getSignedDownloadUrl while removing (raw load only)', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: 'k1' });
      await service.remove(TENANT, CUSTOMER, 'f1');
      expect(storage.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('does not fail the request when R2 deletion errors', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: 'k1' });
      storage.deleteObject.mockRejectedValueOnce(new Error('network error'));
      await expect(service.remove(TENANT, CUSTOMER, 'f1')).resolves.toEqual({ id: 'f1', deleted: true });
    });

    it('skips R2 deletion for legacy rows with no storage_key', async () => {
      files.findOne.mockResolvedValueOnce({ id: 'f1', storage_key: null });
      await service.remove(TENANT, CUSTOMER, 'f1');
      expect(storage.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('lists files with pagination and resolves signed URLs', async () => {
      files.findAndCount.mockResolvedValueOnce([
        [{ id: 'f1', storage_key: 'k1' }, { id: 'f2', storage_key: null }],
        2,
      ]);
      const result = await service.list(TENANT, CUSTOMER, { page: 1, limit: 10 } as any);
      expect(result).toMatchObject({ total: 2 });
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledTimes(1);
      expect(storage.getSignedDownloadUrl).toHaveBeenCalledWith('k1');
    });
  });
});
