/**
 * Upload readiness over HTTP: real app + real Postgres + the REAL AWS SDK v3 client talking to an
 * S3-protocol endpoint (Adobe S3Mock, disposable Testcontainers container, versioned bucket).
 * Unlike `upload-multipart-nesting.e2e-spec.ts` (which stubs the whole client), the bytes really
 * land in a bucket here, so the assertions are about storage state, not about a mock's calls:
 *
 *   - valid / exactly-max / over-max / empty / wrong-type / spoofed / missing-field requests;
 *   - object present with identical bytes, size, content type and sha256, and the matching DB rows;
 *   - 401 / 403 / cross-tenant isolation;
 *   - S3 failure -> no row; database failure after the write -> the object is removed (no orphan);
 *   - repeated identical requests -> distinct objects and rows.
 *
 * S3Mock does not enforce SigV4/KMS/IAM, so those are proven only on real AWS (see report).
 * Docker gating: skipped without a daemon, hard failure when CI/REQUIRE_TESTCONTAINERS is set.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';

import {
  authHeader,
  cleanupTenant,
  createE2eApp,
  createOwnerFixture,
  grantSystemRole,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import { StorageService } from '../src/modules/storage/storage.service';
import { MAX_UPLOAD_BYTES } from '../src/modules/storage/storage.constants';
import { VerificationAuditService } from '../src/modules/verification-audit/verification-audit.service';
import { VerificationAuditLog } from '../src/entities/SaaS-Core/VerificationAuditLog';
import { CustomerFile } from '../src/entities/CRM/CustomerFile';
import { Customer } from '../src/entities/CRM/Customer';
import { CustomerFileService } from '../src/modules/crm/customer-file.service';
import { User } from '../src/entities/Auth&RBAC/User';

function dockerDaemonReachable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
const DOCKER = dockerDaemonReachable();
const REQUIRE_DOCKER =
  process.env.CI === 'true' ||
  process.env.REQUIRE_TESTCONTAINERS === 'true' ||
  process.env.REQUIRE_TESTCONTAINERS === '1';
const describeIfDocker = DOCKER || REQUIRE_DOCKER ? describe : describe.skip;

const S3MOCK_IMAGE =
  'adobe/s3mock@sha256:ab01a6946750f451ca215a47e91030695b260e4003b8a5a6201d25029b8fca92';
const BUCKET = 'zt-e2e-uploads';

const sha = (b: Buffer | Uint8Array) =>
  createHash('sha256').update(b).digest('hex');
const pdf = (bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = 0x20 + (i % 90);
  Buffer.from('%PDF-1.4\n').copy(b);
  return b;
};
const PDF = { filename: 'doc.pdf', contentType: 'application/pdf' };

describeIfDocker('Upload over HTTP against a real S3 protocol endpoint', () => {
  let container: StartedTestContainer;
  let s3: S3Client;
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let other: OwnerFixture;
  let doctorToken: string;
  let customerId: string;
  let storage: StorageService;
  const http = () => e2e.app.getHttpServer();

  const objectKeys = async (prefix: string): Promise<string[]> => {
    const res = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: prefix }),
    );
    return (res.Versions ?? []).map((v) => v.Key!);
  };
  const download = async (key: string) => {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return Buffer.from(await res.Body!.transformToByteArray());
  };

  beforeAll(async () => {
    if (!DOCKER)
      throw new Error(
        'CI / REQUIRE_TESTCONTAINERS is set but the Docker daemon is unreachable.',
      );
    container = await new GenericContainer(S3MOCK_IMAGE)
      .withExposedPorts(9090)
      .withEnvironment({
        COM_ADOBE_TESTING_S3MOCK_STORE_RETAIN_FILES_ON_EXIT: 'false',
      })
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    s3 = new S3Client({
      region: 'eu-central-1',
      endpoint: `http://127.0.0.1:${container.getMappedPort(9090)}`,
      forcePathStyle: true,
      credentials: { accessKeyId: randomUUID(), secretAccessKey: randomUUID() }, // disposable local container
    });
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: BUCKET,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );

    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'up-consistency');
    other = await createOwnerFixture(e2e, 'up-other');

    // A second user in the SAME tenant without the owner/manager role.
    const users = e2e.dataSource.getRepository(User);
    const doctor = await users.save(
      users.create({
        tenant: { id: owner.tenantId } as never,
        email: `doctor-${randomUUID().slice(0, 8)}@example.test`,
        full_name: 'E2E Doctor',
        is_active: true,
      }),
    );
    await grantSystemRole(e2e, doctor.id, 'doctor');
    doctorToken = await e2e.jwt.signAsync(
      { sub: doctor.id, tenantId: owner.tenantId, type: 'access' },
      {
        secret: e2e.config.get<string>(
          'JWT_ACCESS_SECRET',
          'dev-access-secret',
        ),
        expiresIn: '15m',
      },
    );

    const customers = e2e.dataSource.getRepository(Customer);
    customerId = (
      await customers.save(
        customers.create({
          tenant: { id: owner.tenantId } as never,
          full_name: 'Upload Consistency Customer',
          phone: '+10000000001',
          email: `up-customer-${owner.tenantId}@example.test`,
        }),
      )
    ).id;

    // Only the transport is redirected; validation, key building, purge and signing are production code.
    storage = e2e.app.get(StorageService);
    // ConfigService resolved its values before this suite ran, so point the (private) bucket/region at the
    // test bucket directly; the key-building, validation and purge code below it is untouched.
    Object.assign(storage as unknown as Record<string, unknown>, {
      bucket: BUCKET,
      region: 'eu-central-1',
    });
    (storage as unknown as { getClient: () => S3Client }).getClient = () => s3;
  }, 180_000);

  afterAll(async () => {
    for (const t of [owner, other]) {
      if (!t) continue;
      await e2e.dataSource.query(
        `DELETE FROM verification_audit_logs WHERE tenant_id = $1`,
        [t.tenantId],
      );
      await cleanupTenant(e2e, t.tenantId);
    }
    await e2e?.app.close();
    s3?.destroy();
    await container?.stop().catch(() => undefined);
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());

  describe('POST /uploads', () => {
    const post = (
      token: string,
      buffer: Buffer | null,
      opts: { docType?: string; file?: typeof PDF } = {},
    ) => {
      let r = request(http())
        .post('/api/v1/uploads')
        .set(...authHeader(token));
      if (opts.docType !== undefined || buffer)
        r = r.field('docType', opts.docType ?? 'commercial_registration');
      if (buffer) r = r.attach('file', buffer, opts.file ?? PDF);
      return r;
    };

    it('stores the file and returns metadata that matches the object in the bucket and the audit row', async () => {
      const buffer = pdf(8192);
      const res = await post(owner.token, buffer).expect(201);

      const { storageKey, size, sha256, mimeType } = res.body;
      expect(
        storageKey.startsWith(`${owner.tenantId}/commercial_registration/`),
      ).toBe(true);
      expect(size).toBe(8192);
      expect(sha256).toBe(sha(buffer));
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: BUCKET, Key: storageKey }),
      );
      expect(head.ContentLength).toBe(8192);
      expect(head.ContentType).toBe(mimeType);
      expect(head.Metadata?.sha256).toBe(sha(buffer));
      expect(sha(await download(storageKey))).toBe(sha(buffer));

      const audit = await e2e.dataSource
        .getRepository(VerificationAuditLog)
        .findOneBy({ tenant_id: owner.tenantId, action: 'UPLOADED' });
      expect(audit).toBeTruthy();
      expect(JSON.stringify(audit)).toContain(storageKey);
    });

    it('accepts a file of exactly the maximum size, byte for byte', async () => {
      const buffer = pdf(MAX_UPLOAD_BYTES);
      const res = await post(owner.token, buffer).expect(201);
      expect(res.body.size).toBe(MAX_UPLOAD_BYTES);
      expect(sha(await download(res.body.storageKey))).toBe(sha(buffer));
    }, 60_000);

    it('refuses a file one byte over the maximum with 413 and stores nothing', async () => {
      const before = await objectKeys(`${owner.tenantId}/`);
      const res = await post(owner.token, pdf(MAX_UPLOAD_BYTES + 1));
      expect(res.status).toBe(413);
      expect(await objectKeys(`${owner.tenantId}/`)).toHaveLength(
        before.length,
      );
    }, 60_000);

    it.each([
      ['an empty file', Buffer.alloc(0), PDF],
      [
        'a disallowed type',
        pdf(64),
        { filename: 'a.zip', contentType: 'application/zip' },
      ],
      [
        'bytes that are not a PDF',
        Buffer.from('plain text pretending to be a pdf'),
        PDF,
      ],
      [
        'an extension that does not match the type',
        pdf(64),
        { filename: 'a.png', contentType: 'application/pdf' },
      ],
    ])('refuses %s with 400 and stores nothing', async (_l, buffer, file) => {
      const before = await objectKeys(`${owner.tenantId}/`);
      const res = await post(owner.token, buffer, { file });
      expect(res.status).toBe(400);
      expect(await objectKeys(`${owner.tenantId}/`)).toHaveLength(
        before.length,
      );
    });

    it('refuses a request with no file part', async () => {
      const res = await post(owner.token, null, {
        docType: 'commercial_registration',
      });
      expect(res.status).toBe(400);
    });

    it('refuses a request with a file but no docType', async () => {
      const res = await request(http())
        .post('/api/v1/uploads')
        .set(...authHeader(owner.token))
        .attach('file', pdf(64), PDF);
      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated request (401) and a non owner/manager user (403)', async () => {
      await request(http())
        .post('/api/v1/uploads')
        .field('docType', 'x')
        .attach('file', pdf(64), PDF)
        .expect(401);
      const res = await post(doctorToken, pdf(64));
      expect(res.status).toBe(403);
    });

    it('two identical requests create two distinct objects (a retry never overwrites)', async () => {
      const buffer = pdf(300);
      const a = await post(owner.token, buffer).expect(201);
      const b = await post(owner.token, buffer).expect(201);
      expect(a.body.storageKey).not.toBe(b.body.storageKey);
      expect(await objectKeys(a.body.storageKey)).toHaveLength(1);
      expect(await objectKeys(b.body.storageKey)).toHaveLength(1);
    });

    it('leaves no row when S3 rejects the write', async () => {
      const auditBefore = await e2e.dataSource
        .getRepository(VerificationAuditLog)
        .countBy({ tenant_id: owner.tenantId });
      const keysBefore = await objectKeys(`${owner.tenantId}/`);
      jest.spyOn(s3, 'send').mockRejectedValueOnce(
        Object.assign(new Error('AccessDenied'), {
          $metadata: { httpStatusCode: 403 },
        }) as never,
      );

      const res = await post(owner.token, pdf(64));

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(
        await e2e.dataSource
          .getRepository(VerificationAuditLog)
          .countBy({ tenant_id: owner.tenantId }),
      ).toBe(auditBefore);
      expect(await objectKeys(`${owner.tenantId}/`)).toHaveLength(
        keysBefore.length,
      );
    });

    it('removes the object when the audit row cannot be written (no orphan)', async () => {
      const keysBefore = await objectKeys(`${owner.tenantId}/`);
      jest
        .spyOn(e2e.app.get(VerificationAuditService), 'record')
        .mockRejectedValue(new Error('audit db down'));

      const res = await post(owner.token, pdf(64));

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await objectKeys(`${owner.tenantId}/`)).toHaveLength(
        keysBefore.length,
      );
    });
  });

  describe('GET /uploads/signed-url and DELETE /uploads — authorization and tenant isolation', () => {
    it('returns a signed URL for an owned key, refuses another tenant’s key, and the URL serves the same bytes', async () => {
      const buffer = pdf(1500);
      const up = await request(http())
        .post('/api/v1/uploads')
        .set(...authHeader(owner.token))
        .field('docType', 'commercial_registration')
        .attach('file', buffer, PDF)
        .expect(201);
      const key = up.body.storageKey as string;

      const ok = await request(http())
        .get('/api/v1/uploads/signed-url')
        .query({ key })
        .set(...authHeader(owner.token));
      expect(ok.status).toBe(200);
      const url: string = ok.body.url ?? ok.body.signedUrl ?? ok.body.data?.url;
      expect(url).toMatch(/^http/);
      const fetched = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(sha(fetched)).toBe(sha(buffer));

      const cross = await request(http())
        .get('/api/v1/uploads/signed-url')
        .query({ key })
        .set(...authHeader(other.token));
      expect(cross.status).toBe(404);
      const del = await request(http())
        .delete('/api/v1/uploads')
        .query({ key })
        .set(...authHeader(other.token));
      expect(del.status).toBe(404);
      expect(await objectKeys(key)).toHaveLength(1); // still there
    });
  });

  describe('POST /crm/customers/:id/files', () => {
    const url = () => `/api/v1/crm/customers/${customerId}/files`;
    const rows = () =>
      e2e.dataSource
        .getRepository(CustomerFile)
        .find({ where: { tenant: { id: owner.tenantId } as never } });

    it('stores the object and exactly one row that points at it, and deleting removes both', async () => {
      const buffer = pdf(2222);
      const before = (await rows()).length;
      const res = await request(http())
        .post(url())
        .set(...authHeader(owner.token))
        .field('fileName', 'Lab result')
        .attach('file', buffer, {
          filename: 'lab.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const all = await rows();
      expect(all).toHaveLength(before + 1);
      const row = all.find((r) => r.id === res.body.id)!;
      expect(row.storage_key!.startsWith(`${owner.tenantId}/`)).toBe(true);
      expect(sha(await download(row.storage_key!))).toBe(sha(buffer));

      await request(http())
        .delete(`${url()}/${row.id}`)
        .set(...authHeader(owner.token))
        .expect(200);
      expect(await rows()).toHaveLength(before);
      expect(await objectKeys(row.storage_key!)).toHaveLength(0);
    });

    it('removes the object when the row cannot be saved (no orphan)', async () => {
      const keysBefore = await objectKeys(`${owner.tenantId}/customer`);
      const uploadSpy = jest.spyOn(storage, 'upload');
      const files = (
        e2e.app.get(CustomerFileService) as unknown as {
          files: { save: jest.Mock };
        }
      ).files;
      jest
        .spyOn(files, 'save')
        .mockRejectedValue(new Error('db down') as never);
      const res = await request(http())
        .post(url())
        .set(...authHeader(owner.token))
        .attach('file', pdf(100), {
          filename: 'lab.pdf',
          contentType: 'application/pdf',
        });
      // The object really was written before the row failed (otherwise this test proves nothing).
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await objectKeys(`${owner.tenantId}/customer`)).toHaveLength(
        keysBefore.length,
      );
    });

    it('rejects a user without the CRM files permission', async () => {
      const res = await request(http())
        .post(url())
        .set(...authHeader(doctorToken))
        .attach('file', pdf(100), {
          filename: 'lab.pdf',
          contentType: 'application/pdf',
        });
      expect([401, 403]).toContain(res.status);
    });
  });
});
