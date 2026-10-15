import { ConfigService } from '@nestjs/config';

import { StorageService } from './storage.service';
import { ErrorCode } from '../../common/errors';

/**
 * Residency plan P11 — permanent erasure on a VERSIONED bucket. The S3 SDK is
 * replaced by a recorder, so the assertion is on the requests that would reach
 * the bucket. Not a substitute for a run against real S3 (see the report).
 */

type Cmd = { __t: string; input: any };
const sent: Cmd[] = [];
let handler: (c: Cmd) => unknown = () => ({});

jest.mock('@aws-sdk/client-s3', () => {
  const mk = (t: string) =>
    jest.fn().mockImplementation((input: unknown) => ({ __t: t, input }));
  return {
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(async (c: Cmd) => {
        sent.push(c);
        return handler(c);
      }),
    })),
    PutObjectCommand: mk('put'),
    DeleteObjectCommand: mk('delete'),
    DeleteObjectsCommand: mk('deleteMany'),
    HeadObjectCommand: mk('head'),
    GetObjectCommand: mk('get'),
    ListObjectsV2Command: mk('listV2'),
    ListObjectVersionsCommand: mk('listVersions'),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function make(): StorageService {
  const values: Record<string, string> = {
    S3_BUCKET: 'bucket',
    S3_REGION: 'eu-central-1',
  };
  return new StorageService({
    get: (n: string) => values[n],
  } as unknown as ConfigService);
}

const of = (t: string) => sent.filter((c) => c.__t === t);

beforeEach(() => {
  sent.length = 0;
  handler = () => ({});
});

describe('StorageService.purgeObject', () => {
  const key = `${TENANT}/docs/a.pdf`;

  it('removes every version AND delete marker of the key, by version id', async () => {
    handler = (c) =>
      c.__t === 'listVersions'
        ? {
            Versions: [
              { Key: key, VersionId: 'v2' },
              { Key: key, VersionId: 'v1' },
              // A longer key sharing the prefix must NOT be touched.
              { Key: `${key}.bak`, VersionId: 'x1' },
            ],
            DeleteMarkers: [{ Key: key, VersionId: 'dm1' }],
            IsTruncated: false,
          }
        : {};
    const r = await make().purgeObject(key, TENANT);

    expect(r).toEqual({ versionsRemoved: 3 });
    const del = of('deleteMany')[0].input.Delete.Objects;
    expect(del).toEqual([
      { Key: key, VersionId: 'v2' },
      { Key: key, VersionId: 'v1' },
      { Key: key, VersionId: 'dm1' },
    ]);
  });

  it('pages through a truncated listing', async () => {
    let page = 0;
    handler = (c) => {
      if (c.__t !== 'listVersions') return {};
      page += 1;
      return page === 1
        ? {
            Versions: [{ Key: key, VersionId: 'v1' }],
            IsTruncated: true,
            NextKeyMarker: key,
            NextVersionIdMarker: 'v1',
          }
        : { Versions: [{ Key: key, VersionId: 'v2' }], IsTruncated: false };
    };
    expect((await make().purgeObject(key, TENANT)).versionsRemoved).toBe(2);
    expect(of('listVersions')[1].input).toMatchObject({
      KeyMarker: key,
      VersionIdMarker: 'v1',
    });
  });

  it('refuses a key under another tenant before sending anything', async () => {
    await expect(
      make().purgeObject(`${OTHER}/docs/a.pdf`, TENANT),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(sent).toHaveLength(0);
  });

  it('falls back to a plain delete only when the provider has no version API (non-versioned store)', async () => {
    handler = (c) => {
      if (c.__t === 'listVersions')
        throw Object.assign(new Error('x'), { name: 'NotImplemented' });
      return {};
    };
    expect(await make().purgeObject(key, TENANT)).toEqual({
      versionsRemoved: 1,
    });
    expect(of('delete')).toHaveLength(1);
  });

  it('does NOT fall back on any other listing error — a denied purge must surface', async () => {
    handler = (c) => {
      if (c.__t === 'listVersions')
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      return {};
    };
    await expect(make().purgeObject(key, TENANT)).rejects.toThrow('denied');
    expect(of('delete')).toHaveLength(0);
  });

  it('fails when the bucket reports a per-object delete error', async () => {
    handler = (c) =>
      c.__t === 'listVersions'
        ? { Versions: [{ Key: key, VersionId: 'v1' }], IsTruncated: false }
        : c.__t === 'deleteMany'
          ? { Errors: [{ Key: key, Code: 'AccessDenied' }] }
          : {};
    await expect(make().purgeObject(key, TENANT)).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
  });
});

describe('StorageService.purgeTenantPrefix', () => {
  it('lists and purges only under "<tenantId>/"', async () => {
    handler = (c) =>
      c.__t === 'listVersions'
        ? {
            Versions: [{ Key: `${TENANT}/a/1.pdf`, VersionId: 'v1' }],
            DeleteMarkers: [{ Key: `${TENANT}/a/1.pdf`, VersionId: 'd1' }],
            IsTruncated: false,
          }
        : {};
    const r = await make().purgeTenantPrefix(TENANT);
    expect(r.versionsRemoved).toBe(2);
    expect(of('listVersions')[0].input.Prefix).toBe(`${TENANT}/`);
  });

  it('refuses a missing or malformed tenant id — an empty prefix would be the whole bucket', async () => {
    for (const bad of ['', '/', 'not-a-uuid', '../']) {
      await expect(make().purgeTenantPrefix(bad)).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('batches deletes at the S3 limit of 1000', async () => {
    const versions = Array.from({ length: 2500 }, (_, i) => ({
      Key: `${TENANT}/k${i}`,
      VersionId: `v${i}`,
    }));
    handler = (c) =>
      c.__t === 'listVersions'
        ? { Versions: versions, IsTruncated: false }
        : {};
    expect((await make().purgeTenantPrefix(TENANT)).versionsRemoved).toBe(2500);
    expect(of('deleteMany').map((c) => c.input.Delete.Objects.length)).toEqual([
      1000, 1000, 500,
    ]);
  });

  it('falls back to listing current objects when versions cannot be listed', async () => {
    handler = (c) => {
      if (c.__t === 'listVersions')
        throw Object.assign(new Error('x'), { name: 'NotImplemented' });
      if (c.__t === 'listV2')
        return {
          Contents: [{ Key: `${TENANT}/a` }, { Key: `${TENANT}/b` }],
          IsTruncated: false,
        };
      return {};
    };
    expect((await make().purgeTenantPrefix(TENANT)).versionsRemoved).toBe(2);
    expect(of('listV2')[0].input.Prefix).toBe(`${TENANT}/`);
  });
});
