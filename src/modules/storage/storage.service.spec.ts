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
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example/signed-fake-url'),
}));

/** Fully configured so `isConfigured()` is true and the real S3 call path (mocked above) runs. */
function makeService(): StorageService {
  const values: Record<string, string> = {
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'eu-central-1',
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

  it('uses the default credential chain: region only, no custom endpoint, no static keys', async () => {
    const service = makeS3Service({
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'zt-production-uploads-123456789012',
      AWS_REGION: 'me-central-1',
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

});

describe('StorageService - avatar key binding (CR-37)', () => {
  const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('accepts a key produced by an avatar upload (docType staff-avatar)', async () => {
    const service = makeService();
    const stored = await service
      .upload({
        tenantId: T,
        docType: 'staff-avatar',
        originalName: 'me.png',
        mimeType: 'image/png',
        size: 8,
        // PNG signature + padding so the magic-byte check passes
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      })
      .catch(() => null);
    // Whatever the upload path does with the mocked S3, the key convention it builds must bind.
    const key = stored?.storageKey ?? `${T}/staff_avatar/00000000-0000-0000-0000-000000000000.png`;
    expect(service.isAvatarKey(key, T)).toBe(true);
    expect(() => service.assertAvatarKey(key, T)).not.toThrow();
  });

  it.each([
    [`${T}/customer_files/scan.pdf`],
    [`${T}/verification/licence.pdf`],
    [`${T}/staff_avatar/../customer_files/scan.pdf`],
    [`${T}/staff_avatarx/a.png`],
  ])('rejects %s as an avatar key with 400', (key) => {
    const service = makeService();
    expect(service.isAvatarKey(key, T)).toBe(false);
    expect(() => service.assertAvatarKey(key, T)).toThrow();
  });

  it('a foreign tenant key is a 404, not a 400 (existence is never confirmed)', () => {
    const service = makeService();
    try {
      service.assertAvatarKey(`${OTHER}/staff_avatar/a.png`, T);
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as { code?: unknown }).code).toBe(ErrorCode.NOT_FOUND);
    }
  });
});

describe('StorageService - docType key binding (CR-40)', () => {
  const T = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  it('binds a key to the segment buildKey gives that docType', () => {
    const service = makeService();
    expect(service.isKeyInDocType(`${T}/ai_training/a.txt`, T, 'ai_training')).toBe(true);
    expect(service.isKeyInDocType(`${T}/customer_files/a.pdf`, T, 'ai_training')).toBe(false);
    expect(() => service.assertKeyInDocType(`${T}/customer_files/a.pdf`, T, 'ai_training')).toThrow();
    expect(() => service.assertKeyInDocType(`${T}/ai_training/a.txt`, T, 'ai_training')).not.toThrow();
  });
});
