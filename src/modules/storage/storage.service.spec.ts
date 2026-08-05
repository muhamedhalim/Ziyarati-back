import { ConfigService } from '@nestjs/config';

import { StorageService } from './storage.service';
import { ErrorCode } from '../../common/errors';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({}),
  })),
  PutObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://r2.example/signed-fake-url'),
}));

/** Fully configured so `isConfigured()` is true and the real S3 call path (mocked above) runs. */
function makeService(): StorageService {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_BUCKET: 'test-bucket',
    R2_REGION: 'auto',
  };
  const config = {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
  return new StorageService(config);
}

describe('StorageService — tenant-ownership enforcement (FND-039)', () => {
  const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const ownKey = `${TENANT_A}/docs/file.pdf`;
  const foreignKey = `${TENANT_B}/docs/file.pdf`;

  describe('deleteObject', () => {
    it('deletes a key that belongs to the caller tenant', async () => {
      const service = makeService();
      await expect(service.deleteObject(ownKey, TENANT_A)).resolves.toBeUndefined();
    });

    it('refuses to delete a key belonging to a different tenant', async () => {
      const service = makeService();
      await expect(service.deleteObject(foreignKey, TENANT_A)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('getSignedDownloadUrl', () => {
    it('signs a key that belongs to the caller tenant', async () => {
      const service = makeService();
      await expect(service.getSignedDownloadUrl(ownKey, TENANT_A)).resolves.toEqual(
        expect.any(String),
      );
    });

    it('refuses to sign a key belonging to a different tenant', async () => {
      const service = makeService();
      await expect(service.getSignedDownloadUrl(foreignKey, TENANT_A)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('still honors an explicit expiresIn override for an owned key', async () => {
      const service = makeService();
      await expect(
        service.getSignedDownloadUrl(ownKey, TENANT_A, 60),
      ).resolves.toEqual(expect.any(String));
    });
  });
});
