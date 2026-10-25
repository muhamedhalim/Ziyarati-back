/**
 * `StorageService` against a REAL S3 wire protocol (Adobe S3Mock in a disposable
 * Testcontainers container) with the REAL AWS SDK v3 client — nothing in the storage path is
 * mocked. It proves what the service sends and how it behaves on versioned storage
 * (bytes, size, content type, sha256 metadata, tenant gate, versioned purge, orphan discard).
 *
 * It is NOT proof that AWS accepts the same requests: S3Mock does not enforce SigV4, KMS, IAM
 * or bucket policy, so presigned-URL expiry / tampering / unsigned access and the KMS path are
 * proven only by the throwaway-bucket run on real AWS (see the upload-readiness report).
 *
 * Run: npx jest --config test/jest-integration.json test/integration/storage-s3.int-spec.ts
 *
 * Docker gating follows redis-resilience.int-spec.ts: no daemon → skipped locally, a hard
 * failure when CI=true / REQUIRE_TESTCONTAINERS=true.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import { ErrorCode } from '../../src/common/errors';
import { StorageService } from '../../src/modules/storage/storage.service';
import { MAX_UPLOAD_BYTES } from '../../src/modules/storage/storage.constants';

function dockerDaemonReachable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
const DOCKER_AVAILABLE = dockerDaemonReachable();
const REQUIRE_DOCKER =
  process.env.CI === 'true' ||
  process.env.REQUIRE_TESTCONTAINERS === 'true' ||
  process.env.REQUIRE_TESTCONTAINERS === '1';
const describeIfDocker =
  DOCKER_AVAILABLE || REQUIRE_DOCKER ? describe : describe.skip;

// Pinned by digest (supply chain): adobe/s3mock:latest as pulled 2026-10-25.
const S3MOCK_IMAGE =
  'adobe/s3mock@sha256:ab01a6946750f451ca215a47e91030695b260e4003b8a5a6201d25029b8fca92';
const BUCKET = 'zt-test-uploads';
const TENANT = randomUUID();
const OTHER_TENANT = randomUUID();

const pdf = (bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = 0x20 + (i % 90); // varied, non-trivial content
  Buffer.from('%PDF-1.4\n').copy(b);
  return b;
};
const sha = (b: Buffer | Uint8Array) =>
  createHash('sha256').update(b).digest('hex');

describeIfDocker(
  'StorageService against a real S3 protocol endpoint (SDK v3, versioned bucket)',
  () => {
    let container: StartedTestContainer;
    let s3: S3Client;
    let storage: StorageService;

    beforeAll(async () => {
      if (!DOCKER_AVAILABLE) {
        throw new Error(
          'REQUIRE_TESTCONTAINERS / CI is set but the Docker daemon is unreachable - this suite must run, not skip.',
        );
      }
      container = await new GenericContainer(S3MOCK_IMAGE)
        .withExposedPorts(9090)
        .withEnvironment({
          COM_ADOBE_TESTING_S3MOCK_STORE_RETAIN_FILES_ON_EXIT: 'false',
        })
        .withWaitStrategy(Wait.forListeningPorts())
        .start();
      const endpoint = `http://127.0.0.1:${container.getMappedPort(9090)}`;
      // Throw-away credentials for a disposable local container only; generated per run.
      const credentials = {
        accessKeyId: randomUUID(),
        secretAccessKey: randomUUID(),
      };
      s3 = new S3Client({
        region: 'eu-central-1',
        endpoint,
        forcePathStyle: true,
        credentials,
      });
      await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
      await s3.send(
        new PutBucketVersioningCommand({
          Bucket: BUCKET,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );

      const config = {
        get: (n: string) =>
          (
            ({ S3_BUCKET: BUCKET, S3_REGION: 'eu-central-1' }) as Record<
              string,
              string
            >
          )[n],
      };
      storage = new StorageService(config as unknown as ConfigService);
      // Only the transport is redirected to the emulator; every code path above it is the production one.
      (storage as unknown as { getClient: () => S3Client }).getClient = () =>
        s3;
    }, 180_000);

    afterAll(async () => {
      s3?.destroy();
      await container?.stop().catch(() => undefined);
    });

    const download = async (key: string) => {
      const res = await s3.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: key }),
      );
      return Buffer.from(await res.Body!.transformToByteArray());
    };

    it('stores a small valid file: bytes, size, content type and sha256 metadata round-trip', async () => {
      const buffer = pdf(4096);
      const stored = await storage.upload({
        tenantId: TENANT,
        docType: 'commercial_registration',
        originalName: 'cr.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        buffer,
      });

      const head = await s3.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: stored.storageKey }),
      );
      expect(head.ContentLength).toBe(4096);
      expect(head.ContentType).toBe('application/pdf');
      expect(head.Metadata?.sha256).toBe(sha(buffer));
      expect(
        stored.storageKey.startsWith(`${TENANT}/commercial_registration/`),
      ).toBe(true);
      expect(sha(await download(stored.storageKey))).toBe(sha(buffer));
      await expect(storage.objectExists(stored.storageKey)).resolves.toBe(true);
    });

    it('stores a file of exactly the maximum size byte-for-byte', async () => {
      const buffer = pdf(MAX_UPLOAD_BYTES);
      const stored = await storage.upload({
        tenantId: TENANT,
        docType: 'max_size',
        originalName: 'max.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        buffer,
      });
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: stored.storageKey }),
      );
      expect(head.ContentLength).toBe(MAX_UPLOAD_BYTES);
      expect(sha(await download(stored.storageKey))).toBe(sha(buffer));
    }, 60_000);

    it('writes nothing for refused input (empty, wrong type, spoofed bytes)', async () => {
      const before = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: BUCKET,
          Prefix: `${OTHER_TENANT}/`,
        }),
      );
      const bad = [
        {
          buffer: Buffer.alloc(0),
          mimeType: 'application/pdf',
          originalName: 'a.pdf',
        },
        { buffer: pdf(64), mimeType: 'application/zip', originalName: 'a.zip' },
        {
          buffer: Buffer.from('plain text pretending to be a pdf'),
          mimeType: 'application/pdf',
          originalName: 'a.pdf',
        },
      ];
      for (const b of bad) {
        await expect(
          storage.upload({
            tenantId: OTHER_TENANT,
            docType: 'refused',
            size: b.buffer.length,
            ...b,
          }),
        ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
      }
      const after = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: BUCKET,
          Prefix: `${OTHER_TENANT}/`,
        }),
      );
      expect(after.Versions ?? []).toHaveLength((before.Versions ?? []).length);
    });

    it('a retried identical upload creates a distinct object (never overwrites)', async () => {
      const buffer = pdf(256);
      const mk = () =>
        storage.upload({
          tenantId: TENANT,
          docType: 'retry',
          originalName: 'r.pdf',
          mimeType: 'application/pdf',
          size: buffer.length,
          buffer,
        });
      const [a, b] = [await mk(), await mk()];
      expect(a.storageKey).not.toBe(b.storageKey);
    });

    it('objectExists is false for a missing key (404), not an error', async () => {
      await expect(
        storage.objectExists(`${TENANT}/nothing/${randomUUID()}.pdf`),
      ).resolves.toBe(false);
    });

    it('refuses a key under another tenant prefix for sign, download and delete', async () => {
      const key = `${OTHER_TENANT}/docs/${randomUUID()}.pdf`;
      await expect(
        storage.getSignedDownloadUrl(key, TENANT),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      await expect(
        storage.downloadObject(key, TENANT, 1024),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
      await expect(storage.deleteObject(key, TENANT)).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });

    it('signs a GET URL for an owned key (host, key and SigV4 expiry parameters present)', async () => {
      const buffer = pdf(128);
      const stored = await storage.upload({
        tenantId: TENANT,
        docType: 'sign',
        originalName: 's.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        buffer,
      });
      const url = new URL(
        await storage.getSignedDownloadUrl(stored.storageKey, TENANT, 60),
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(decodeURIComponent(url.pathname)).toContain(stored.storageKey);
    });

    it('purgeObject removes every version and delete marker of a key', async () => {
      const key = `${TENANT}/purge/${randomUUID()}.pdf`;
      for (const body of ['v1', 'v2', 'v3']) {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: Buffer.from(body),
          }),
        );
      }
      const before = await s3.send(
        new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }),
      );
      expect(before.Versions).toHaveLength(3);

      const { versionsRemoved } = await storage.purgeObject(key, TENANT);

      expect(versionsRemoved).toBe(3);
      const after = await s3.send(
        new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }),
      );
      expect(after.Versions ?? []).toHaveLength(0);
      expect(after.DeleteMarkers ?? []).toHaveLength(0);
      await expect(storage.objectExists(key)).resolves.toBe(false);
    });

    it('discardOrphan removes an object written by a request whose database write then failed', async () => {
      const buffer = pdf(512);
      const stored = await storage.upload({
        tenantId: TENANT,
        docType: 'orphan',
        originalName: 'o.pdf',
        mimeType: 'application/pdf',
        size: buffer.length,
        buffer,
      });
      await expect(storage.objectExists(stored.storageKey)).resolves.toBe(true);

      await storage.discardOrphan(stored.storageKey, TENANT);

      await expect(storage.objectExists(stored.storageKey)).resolves.toBe(
        false,
      );
      const versions = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: BUCKET,
          Prefix: stored.storageKey,
        }),
      );
      expect(
        (versions.Versions ?? []).length +
          (versions.DeleteMarkers ?? []).length,
      ).toBe(0);
    });
  },
);
