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

describe('StorageService — STORAGE_PROVIDER=s3 (AWS migration)', () => {
  const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const { S3Client } = jest.requireMock('@aws-sdk/client-s3');

  function makeS3Service(values: Record<string, string>): StorageService {
    const config = { get: (name: string) => values[name] } as unknown as ConfigService;
    return new StorageService(config);
  }

  beforeEach(() => (S3Client as jest.Mock).mockClear());

  it('uses the default credential chain: region only, no R2 endpoint, no static keys', async () => {
    const service = makeS3Service({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'zt-production-uploads-123456789012',
      AWS_REGION: 'me-central-1',
      // Leftover R2 values must be ignored in S3 mode.
      R2_ACCOUNT_ID: 'old',
      R2_ACCESS_KEY_ID: 'old',
      R2_SECRET_ACCESS_KEY: 'old',
    });
    expect(service.isConfigured()).toBe(true);
    await service.deleteObject(`${TENANT_A}/docs/x.pdf`, TENANT_A);
    expect(S3Client).toHaveBeenCalledTimes(1);
    expect(S3Client).toHaveBeenCalledWith({ region: 'me-central-1' });
  });

  it('prefers S3_REGION over AWS_REGION', async () => {
    const service = makeS3Service({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'b',
      S3_REGION: 'eu-central-1',
      AWS_REGION: 'me-central-1',
    });
    await service.deleteObject(`${TENANT_A}/docs/x.pdf`, TENANT_A);
    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-central-1' });
  });

  it('is not configured without a bucket and fails closed with a message naming the S3 variables', async () => {
    const service = makeS3Service({ STORAGE_PROVIDER: 's3', AWS_REGION: 'me-central-1' });
    expect(service.isConfigured()).toBe(false);
    await expect(service.deleteObject(`${TENANT_A}/docs/x.pdf`, TENANT_A)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
      message: expect.stringContaining('S3_BUCKET'),
    });
    expect(S3Client).not.toHaveBeenCalled();
  });

  it('keeps tenant-prefix enforcement unchanged', async () => {
    const service = makeS3Service({ STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', AWS_REGION: 'me-central-1' });
    await expect(
      service.getSignedDownloadUrl(`${TENANT_B}/docs/x.pdf`, TENANT_A),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('defaults to R2 when STORAGE_PROVIDER is unset (rollback path)', async () => {
    const service = makeS3Service({
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET: 'b',
    });
    await service.deleteObject(`${TENANT_A}/docs/x.pdf`, TENANT_A);
    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://acct.r2.cloudflarestorage.com' }),
    );
  });
});
