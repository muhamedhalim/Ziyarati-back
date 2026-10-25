/**
 * MANUAL real-AWS proof of the upload path. Not part of CI: it only runs when
 * `UPLOAD_PROOF_BUCKET` names a THROWAWAY bucket (see infra/scripts/upload-proof/README.md) and the
 * process holds credentials of the least-privilege proof role. Without it the whole suite is skipped.
 *
 * It drives the real HTTP stack (real app + Postgres) with NO storage stub: `StorageService` uses
 * the SDK default credential chain against real S3 + KMS, exactly as the ECS task role does. It
 * verifies what a mock cannot: SSE-KMS applied by the bucket default, the deny-policy accepting the
 * request, presigned-URL expiry / tamper / unsigned behaviour, and versioned purge.
 * Synthetic files only.
 */
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  authHeader,
  cleanupTenant,
  createE2eApp,
  createOwnerFixture,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import { StorageService } from '../src/modules/storage/storage.service';
import { VerificationAuditService } from '../src/modules/verification-audit/verification-audit.service';
import { VerificationAuditLog } from '../src/entities/SaaS-Core/VerificationAuditLog';

const BUCKET = process.env.UPLOAD_PROOF_BUCKET;
const REGION = process.env.UPLOAD_PROOF_REGION ?? 'eu-central-1';
const KMS_KEY_ARN = process.env.UPLOAD_PROOF_KMS_KEY_ARN;
const describeIfProof = BUCKET ? describe : describe.skip;

const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const pdf = (bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = 0x20 + (i % 90);
  Buffer.from('%PDF-1.4\n').copy(b);
  return b;
};
const PDF = { filename: 'proof.pdf', contentType: 'application/pdf' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfProof('REAL AWS: upload -> S3 (SSE-KMS) -> DB -> authorised read -> cleanup', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let other: OwnerFixture;
  let s3: S3Client;
  const created: string[] = [];
  const http = () => e2e.app.getHttpServer();

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'aws-proof');
    other = await createOwnerFixture(e2e, 'aws-proof-other');
    s3 = new S3Client({ region: REGION }); // default credential chain: the proof role
    const storage = e2e.app.get(StorageService);
    // Config was resolved before this suite; point the private fields at the proof bucket.
    Object.assign(storage as unknown as Record<string, unknown>, { bucket: BUCKET, region: REGION });
    expect(storage.isConfigured()).toBe(true);
  }, 120_000);

  afterAll(async () => {
    // Remove ONLY what this run created: every version of every key it recorded.
    const storage = e2e.app.get(StorageService);
    for (const key of created) await storage.purgeObject(key, owner.tenantId).catch(() => undefined);
    for (const t of [owner, other]) {
      await e2e.dataSource.query(`DELETE FROM verification_audit_logs WHERE tenant_id = $1`, [t.tenantId]);
      await cleanupTenant(e2e, t.tenantId);
    }
    await e2e.app.close();
    s3.destroy();
  }, 120_000);

  const upload = (token: string, buffer: Buffer) =>
    request(http())
      .post('/api/v1/uploads')
      .set(...authHeader(token))
      .field('docType', 'commercial_registration')
      .attach('file', buffer, PDF);

  it('stores the object in the right bucket/region with SSE-KMS, identical bytes, size, content type, sha256 and a DB audit row', async () => {
    const buffer = pdf(64 * 1024);
    const res = await upload(owner.token, buffer).expect(201);
    const key = res.body.storageKey as string;
    created.push(key);

    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(head.ContentLength).toBe(buffer.length);
    expect(head.ContentType).toBe('application/pdf');
    expect(head.Metadata?.sha256).toBe(sha(buffer));
    expect(head.ServerSideEncryption).toBe('aws:kms'); // applied by the bucket default, not by the app
    if (KMS_KEY_ARN) expect(head.SSEKMSKeyId).toBe(KMS_KEY_ARN);
    const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    expect(sha(await body.Body!.transformToByteArray())).toBe(sha(buffer));
    expect(res.body.sha256).toBe(sha(buffer));

    const audit = await e2e.dataSource
      .getRepository(VerificationAuditLog)
      .findOneBy({ tenant_id: owner.tenantId, action: 'UPLOADED' });
    expect(JSON.stringify(audit)).toContain(key);
  }, 60_000);

  it('stores a file of exactly the maximum size (10 MiB) intact', async () => {
    const buffer = pdf(10 * 1024 * 1024);
    const res = await upload(owner.token, buffer).expect(201);
    created.push(res.body.storageKey);
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: res.body.storageKey }));
    expect(head.ContentLength).toBe(buffer.length);
    const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: res.body.storageKey }));
    expect(sha(await body.Body!.transformToByteArray())).toBe(sha(buffer));
  }, 180_000);

  it('refuses over-limit / empty / wrong-type input and writes nothing', async () => {
    const before = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${other.tenantId}/` }));
    expect((await upload(other.token, pdf(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(other.token, Buffer.alloc(0))).status).toBe(400);
    expect((await upload(other.token, Buffer.from('not a pdf, just text'))).status).toBe(400);
    const after = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${other.tenantId}/` }));
    expect(after.Versions ?? []).toHaveLength((before.Versions ?? []).length);
  }, 120_000);

  it('serves the object through the authorised signed-URL route; expired, tampered and unsigned access are denied; another tenant is refused', async () => {
    const buffer = pdf(2048);
    const up = await upload(owner.token, buffer).expect(201);
    const key = up.body.storageKey as string;
    created.push(key);

    const ok = await request(http()).get('/api/v1/uploads/signed-url').query({ key }).set(...authHeader(owner.token));
    expect(ok.status).toBe(200);
    const url: string = ok.body.url;
    expect(new URL(url).hostname).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
    const good = await fetch(url);
    expect(good.status).toBe(200);
    expect(sha(Buffer.from(await good.arrayBuffer()))).toBe(sha(buffer));

    // Unsigned (the public-access probe) and tampered signature.
    expect((await fetch(url.split('?')[0])).status).toBe(403);
    const tampered = url.replace(/(X-Amz-Signature=)([0-9a-f])/, (_m, p, c) => p + (c === '0' ? '1' : '0'));
    expect((await fetch(tampered)).status).toBe(403);

    // Expiry: a 2-second URL minted by the same service call used by the routes.
    const short = await e2e.app.get(StorageService).getSignedDownloadUrl(key, owner.tenantId, 2);
    expect((await fetch(short)).status).toBe(200);
    await sleep(4000);
    expect((await fetch(short)).status).toBe(403);

    const cross = await request(http()).get('/api/v1/uploads/signed-url').query({ key }).set(...authHeader(other.token));
    expect(cross.status).toBe(404);
  }, 60_000);

  it('removes the object when the audit row cannot be written (no orphan on real S3)', async () => {
    const before = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${other.tenantId}/` }));
    jest.spyOn(e2e.app.get(VerificationAuditService), 'record').mockRejectedValue(new Error('audit db down'));
    const res = await upload(other.token, pdf(1024));
    jest.restoreAllMocks();
    expect(res.status).toBeGreaterThanOrEqual(500);
    const after = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: `${other.tenantId}/` }));
    expect((after.Versions ?? []).length + (after.DeleteMarkers ?? []).length).toBe(
      (before.Versions ?? []).length + (before.DeleteMarkers ?? []).length,
    );
  }, 60_000);

  it('purges every version of a key (versioned bucket)', async () => {
    const res = await upload(owner.token, pdf(512)).expect(201);
    const key = res.body.storageKey as string;
    const storage = e2e.app.get(StorageService);
    await storage.deleteObject(key, owner.tenantId); // writes a delete marker; the version remains
    const mid = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    expect((mid.Versions ?? []).length).toBe(1);
    expect((mid.DeleteMarkers ?? []).length).toBe(1);

    await storage.purgeObject(key, owner.tenantId);

    const after = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    expect((after.Versions ?? []).length + (after.DeleteMarkers ?? []).length).toBe(0);
    void randomUUID;
  }, 60_000);
});
