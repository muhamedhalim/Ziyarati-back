import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { ErrorCode } from '../../common/errors';
import { StorageService } from './storage.service';
import { MAX_UPLOAD_BYTES } from './storage.constants';

/**
 * What `upload()` / `objectExists()` / `discardOrphan()` do with S3, using the REAL
 * validation and key logic and a recording stand-in for the SDK client. This proves
 * the request the service builds; it is NOT proof that AWS accepts it (that needs a
 * real bucket — see the throwaway-bucket run).
 */
const sent: Array<{ name: string; input: any }> = [];
let respond: (name: string, input: any) => unknown = () => ({});

jest.mock('@aws-sdk/client-s3', () => {
  const cmd = (name: string) =>
    class {
      constructor(public input: any) {}
      static readonly cmdName = name;
    };
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(async (command: any) => {
        const name = command.constructor.cmdName as string;
        sent.push({ name, input: command.input });
        return respond(name, command.input);
      }),
    })),
    PutObjectCommand: cmd('Put'),
    DeleteObjectCommand: cmd('Delete'),
    DeleteObjectsCommand: cmd('DeleteMany'),
    HeadObjectCommand: cmd('Head'),
    GetObjectCommand: cmd('Get'),
    ListObjectVersionsCommand: cmd('ListVersions'),
    ListObjectsV2Command: cmd('ListObjects'),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example/signed'),
}));

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeService(): StorageService {
  const values: Record<string, string> = {
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'eu-central-1',
  };
  return new StorageService({
    get: (n: string) => values[n],
  } as unknown as ConfigService);
}

/** A buffer that satisfies the PDF signature, padded to `bytes`. */
const pdf = (bytes: number): Buffer => {
  const b = Buffer.alloc(bytes, 0x20);
  Buffer.from('%PDF-1.4\n').copy(b);
  return b;
};

const input = (buffer: Buffer, over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  docType: 'commercial_registration',
  originalName: 'cr.pdf',
  mimeType: 'application/pdf',
  size: buffer.length,
  buffer,
  ...over,
});

beforeEach(() => {
  sent.length = 0;
  respond = () => ({});
});

describe('StorageService.upload — what is written to S3', () => {
  it('writes the exact bytes once, tenant-prefixed, with content type, length and a matching sha256', async () => {
    const buffer = pdf(2048);

    const stored = await makeService().upload(input(buffer));

    expect(sent).toHaveLength(1);
    const put = sent[0];
    expect(put.name).toBe('Put');
    expect(put.input.Bucket).toBe('test-bucket');
    expect(put.input.Key).toBe(stored.storageKey);
    expect(put.input.Key).toMatch(
      new RegExp(`^${TENANT}/commercial_registration/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(put.input.Body).toBe(buffer);
    expect(put.input.ContentType).toBe('application/pdf');
    expect(put.input.ContentLength).toBe(2048);
    const digest = createHash('sha256').update(buffer).digest('hex');
    expect(put.input.Metadata).toEqual({ sha256: digest });
    expect(stored).toMatchObject({ size: 2048, sha256: digest });
    // Encryption must come from the bucket default (SSE-KMS), never a per-request override.
    expect(put.input.ServerSideEncryption).toBeUndefined();
    expect(put.input.ACL).toBeUndefined();
  });

  it('gives a repeated identical upload a NEW key (a retry never overwrites another object)', async () => {
    const service = makeService();
    const a = await service.upload(input(pdf(64)));
    const b = await service.upload(input(pdf(64)));
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(a.sha256).toBe(b.sha256);
  });

  it('accepts a file of exactly the maximum size', async () => {
    await expect(
      makeService().upload(input(pdf(MAX_UPLOAD_BYTES))),
    ).resolves.toMatchObject({ size: MAX_UPLOAD_BYTES });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['an empty file', Buffer.alloc(0), 'application/pdf', 'cr.pdf'],
    ['a type outside the allow-list', pdf(64), 'application/zip', 'cr.zip'],
    [
      'bytes that do not match the declared type',
      Buffer.from('not a pdf at all, just text'),
      'application/pdf',
      'cr.pdf',
    ],
    [
      'an extension that does not match the type',
      pdf(64),
      'application/pdf',
      'cr.png',
    ],
  ])(
    'refuses %s and writes nothing to S3',
    async (_label, buffer, mimeType, originalName) => {
      await expect(
        makeService().upload(input(buffer, { mimeType, originalName })),
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(sent).toHaveLength(0);
    },
  );

  it('surfaces an S3 failure and reports no stored object', async () => {
    respond = () => {
      throw Object.assign(new Error('AccessDenied'), {
        $metadata: { httpStatusCode: 403 },
      });
    };
    await expect(makeService().upload(input(pdf(64)))).rejects.toThrow(
      'AccessDenied',
    );
  });
});

describe('StorageService.objectExists — only a 404 means "missing"', () => {
  const fail = (status: number) => () => {
    throw Object.assign(new Error(`http ${status}`), {
      $metadata: { httpStatusCode: status },
    });
  };

  it('is true when HEAD succeeds', async () => {
    await expect(makeService().objectExists(`${TENANT}/x/y.pdf`)).resolves.toBe(
      true,
    );
  });

  it('is false on 404', async () => {
    respond = fail(404);
    await expect(makeService().objectExists(`${TENANT}/x/y.pdf`)).resolves.toBe(
      false,
    );
  });

  it('throws on 403 instead of reporting the file as missing (an IAM/KMS fault is not "not found")', async () => {
    respond = fail(403);
    await expect(
      makeService().objectExists(`${TENANT}/x/y.pdf`),
    ).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });

  it('throws on a 5xx', async () => {
    respond = fail(503);
    await expect(
      makeService().objectExists(`${TENANT}/x/y.pdf`),
    ).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });
});

describe('StorageService.discardOrphan — best-effort compensation', () => {
  it('removes the object through the permanent purge path', async () => {
    respond = (name) =>
      name === 'ListVersions' ? { Versions: [], DeleteMarkers: [] } : {};
    await makeService().discardOrphan(`${TENANT}/x/y.pdf`, TENANT);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.input.Bucket === 'test-bucket')).toBe(true);
  });

  it('never throws, so it cannot mask the error that triggered it', async () => {
    respond = () => {
      throw new Error('s3 unreachable');
    };
    await expect(
      makeService().discardOrphan(`${TENANT}/x/y.pdf`, TENANT),
    ).resolves.toBeUndefined();
  });

  it('refuses a key outside the tenant prefix without calling S3', async () => {
    await expect(
      makeService().discardOrphan(
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/x/y.pdf',
        TENANT,
      ),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
