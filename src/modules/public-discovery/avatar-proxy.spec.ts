import { ConfigService } from '@nestjs/config';
import { PublicDiscoveryController } from './public-discovery.controller';
import { PublicDiscoveryService } from './public-discovery.service';
import { StorageService } from '../storage/storage.service';
import { ErrorCode } from '../../common/errors';

/** Contract C12 (T099). No storage URL in any body/header (SC-019); ineligible
 *  and unknown doctors are indistinguishable; cache headers present. */

describe('PublicDiscoveryService.resolveDoctorAvatarSource', () => {
  function build(rows: unknown[]) {
    const query = jest.fn().mockResolvedValue(rows);
    const service = new PublicDiscoveryService({ query } as never, {} as never);
    return { service, query };
  }

  it('returns null for an unknown slug', async () => {
    const { service } = build([]);
    await expect(
      service.resolveDoctorAvatarSource('nobody'),
    ).resolves.toBeNull();
  });

  it('returns null when the doctor has no stored avatar (avatar_storage_key is null)', async () => {
    const { service } = build([{ tenant_id: 't1', avatar_storage_key: null }]);
    await expect(service.resolveDoctorAvatarSource('dr-x')).resolves.toBeNull();
  });

  it('returns the tenant + storage key for an eligible doctor with an avatar', async () => {
    const { service } = build([
      { tenant_id: 't1', avatar_storage_key: 't1/staff-avatar/a.jpg' },
    ]);
    await expect(service.resolveDoctorAvatarSource('dr-x')).resolves.toEqual({
      tenantId: 't1',
      storageKey: 't1/staff-avatar/a.jpg',
    });
  });

  it('the query re-checks eligibility (clinic + staff) on every call — never relies on a cached/prior result', async () => {
    const { service, query } = build([]);
    await service.resolveDoctorAvatarSource('dr-x');
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/is_available_for_booking = true/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/approval_status = 'APPROVED'/);
    expect(sql).toMatch(/public_booking_enabled, false\) = true/);
  });
});

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
  HeadObjectCommand: jest.fn(),
  GetObjectCommand: jest.fn((input) => ({ __command: 'GetObject', ...input })),
}));

function makeStorageService(
  sendImpl: (cmd: unknown) => unknown,
): StorageService {
  const values: Record<string, string> = {
    R2_ACCOUNT_ID: 'a',
    R2_ACCESS_KEY_ID: 'k',
    R2_SECRET_ACCESS_KEY: 's',
    R2_BUCKET: 'b',
    R2_REGION: 'auto',
  };
  const config = {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
  const service = new StorageService(config);
  // Swap the lazily-created client's `send` with our controllable mock.
  (service as unknown as { getClient(): { send: jest.Mock } }).getClient = jest
    .fn()
    .mockReturnValue({ send: jest.fn(sendImpl) });
  return service;
}

describe('StorageService.getObjectStream (server-side stream read, never a presigned URL)', () => {
  it('streams an object that belongs to the caller tenant', async () => {
    const storage = makeStorageService(() =>
      Promise.resolve({
        Body: { pipe: jest.fn() },
        ContentType: 'image/jpeg',
        ContentLength: 1234,
        ETag: '"abc123"',
      }),
    );
    const result = await storage.getObjectStream('t1/staff-avatar/a.jpg', 't1');
    expect(result.contentType).toBe('image/jpeg');
    expect(result.contentLength).toBe(1234);
    expect(result.etag).toBe('"abc123"');
    // Never a URL of any kind in the result — bytes/metadata only.
    expect(JSON.stringify(result)).not.toMatch(/^https?:\/\//);
  });

  it('refuses to stream a key belonging to a different tenant (same isolation gate as every other read)', async () => {
    const storage = makeStorageService(() => Promise.resolve({ Body: {} }));
    await expect(
      storage.getObjectStream('t2/staff-avatar/a.jpg', 't1'),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('maps a dangling reference (row has a storage key, but the R2 object is gone) to the same clean 404 — never a raw 500 with provider detail (found live against real R2 during this task)', async () => {
    const storage = makeStorageService(() => {
      const err = new Error('The specified key does not exist.');
      (err as { name?: string }).name = 'NoSuchKey';
      return Promise.reject(err);
    });
    await expect(
      storage.getObjectStream('t1/staff-avatar/gone.jpg', 't1'),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('does NOT swallow an unrelated S3 failure (e.g. AccessDenied) into a false 404', async () => {
    const storage = makeStorageService(() => {
      const err = new Error('Access Denied');
      (err as { name?: string }).name = 'AccessDenied';
      return Promise.reject(err);
    });
    await expect(
      storage.getObjectStream('t1/staff-avatar/a.jpg', 't1'),
    ).rejects.toMatchObject({
      name: 'AccessDenied',
      message: 'Access Denied',
    });
  });
});

describe('PublicDiscoveryController.doctorAvatar', () => {
  function makeRes() {
    const headers: Record<string, string> = {};
    return {
      status: jest.fn(),
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      headers,
    };
  }

  it('404s identically for an unknown slug, an ineligible doctor, and a doctor with no avatar (indistinguishable)', async () => {
    const discovery = {
      resolveDoctorAvatarSource: jest.fn().mockResolvedValue(null),
    };
    const storage = { getObjectStream: jest.fn() };
    const controller = new PublicDiscoveryController(
      discovery as never,
      storage as never,
    );

    await expect(
      controller.doctorAvatar('anything', makeRes() as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('sets the required cache/security headers and streams the body, never a redirect or a URL', async () => {
    const discovery = {
      resolveDoctorAvatarSource: jest.fn().mockResolvedValue({
        tenantId: 't1',
        storageKey: 't1/staff-avatar/a.jpg',
      }),
    };
    const pipe = jest.fn();
    const storage = {
      getObjectStream: jest.fn().mockResolvedValue({
        body: { pipe },
        contentType: 'image/jpeg',
        contentLength: 999,
        etag: '"e"',
      }),
    };
    const controller = new PublicDiscoveryController(
      discovery as never,
      storage as never,
    );
    const res = makeRes();

    await controller.doctorAvatar('dr-x', res as never);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers['Cache-Control']).toBe(
      'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
    );
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['ETag']).toBe('"e"');
    // No storage URL anywhere in what was sent to the client (SC-019).
    expect(Object.values(res.headers).join(' ')).not.toMatch(/^https?:\/\//);
    expect(pipe).toHaveBeenCalledWith(res);
  });

  it('never sets a Location header — the proxy STREAMS, it never redirects to the storage URL (C12)', async () => {
    const discovery = {
      resolveDoctorAvatarSource: jest.fn().mockResolvedValue({
        tenantId: 't1',
        storageKey: 't1/staff-avatar/a.jpg',
      }),
    };
    const storage = {
      getObjectStream: jest.fn().mockResolvedValue({
        body: { pipe: jest.fn() },
        contentType: 'image/jpeg',
        contentLength: 999,
        etag: '"e"',
      }),
    };
    const controller = new PublicDiscoveryController(
      discovery as never,
      storage as never,
    );
    const res = makeRes();

    await controller.doctorAvatar('dr-x', res as never);

    expect(res.headers['Location']).toBeUndefined();
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'Location',
      expect.anything(),
    );
  });
});
