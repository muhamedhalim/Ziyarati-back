/**
 * ZT-004b regression coverage — multipart field-name nesting DoS
 * (GHSA-72gw-mp4g-v24j). `multer@2.1.1`'s parent (`@nestjs/platform-express`)
 * pinned it exactly, so no advisory sweep could reach it; the parent bump to
 * 11.1.29 lifts `multer` to 2.2.0, which adds a `fieldNestingDepth` check but
 * gates it on `hasOwnProperty(limits, 'fieldNestingDepth')` — so the bump
 * alone enforces nothing (research.md D2/D3). This suite proves, for all
 * three multipart upload routes:
 *   1. a legitimate upload still succeeds;
 *   2. an excessively nested field name is rejected;
 *   3. the pre-existing oversized-file and magic-byte-mismatch protections
 *      are untouched.
 *
 * `StorageService`'s real validation logic (MIME allow-list, extension
 * match, magic bytes) runs UNMOCKED — only its private `getClient()` (the
 * actual Cloudflare R2 network call) is stubbed, so a "legitimate upload
 * succeeds" assertion here is never a call against the real, shared R2
 * bucket this repo's `.env` happens to hold credentials for.
 */
import request from 'supertest';

import {
  createE2eApp,
  createOwnerFixture,
  authHeader,
  cleanupTenant,
  type E2eApp,
  type OwnerFixture,
} from './utils/whatsapp-e2e-app';
import { StorageService } from '../src/modules/storage/storage.service';
import { Customer } from '../src/entities/CRM/Customer';

/** `[` × 6 → nesting depth 6, one past the `fieldNestingDepth: 5` bound. */
const OVER_NESTED_FIELD_NAME = 'a[b][c][d][e][f][g]';

const validPdf = (): Buffer =>
  Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(256, 0x41)]);
/** Declares PDF but is not one — must still be rejected by magic-byte checks. */
const spoofedPdf = (): Buffer =>
  Buffer.from('this is not actually a pdf, just text pretending to be one');
/** One byte past the 10 MB default `UPLOAD_MAX_BYTES` / multer `fileSize` limit. */
const oversizedPdf = (): Buffer =>
  Buffer.concat([
    Buffer.from('%PDF-1.4\n'),
    Buffer.alloc(10 * 1024 * 1024 + 1, 0x41),
  ]);

describe('ZT-004b — multipart field-name nesting bound (all three upload routes)', () => {
  let e2e: E2eApp;
  let owner: OwnerFixture;
  let customerId: string;
  /** Restores the real StorageService.getClient() implementation. */
  let restoreStorageClient: () => void;

  beforeAll(async () => {
    e2e = await createE2eApp();
    owner = await createOwnerFixture(e2e, 'upload-nest');

    const customers = e2e.dataSource.getRepository(Customer);
    const customer = await customers.save(
      customers.create({
        tenant: { id: owner.tenantId } as never,
        full_name: 'Nesting Test Customer',
        phone: '+10000000000',
        email: `nesting-customer-${owner.tenantId}@example.test`,
      }),
    );
    customerId = customer.id;

    // Stub only the network boundary. `upload()`'s real MIME/extension/magic
    // -byte/size validation all still run — this is what makes the
    // "existing protections unchanged" assertions below meaningful rather
    // than assertions about a mock's own behaviour. `getSignedDownloadUrl`
    // (used by the customer-file route's response shaping) is stubbed
    // separately: `@aws-sdk/s3-request-presigner`'s `getSignedUrl` reads
    // `client.config` to compute a SigV4 signature, which a bare `{ send }`
    // fake does not have.
    const storage = e2e.app.get(StorageService);
    const send = jest.fn().mockResolvedValue({});
    const original = (storage as unknown as { getClient: () => unknown })
      .getClient;
    (storage as unknown as { getClient: () => unknown }).getClient = () => ({
      send,
    });
    const signedUrlSpy = jest
      .spyOn(storage, 'getSignedDownloadUrl')
      .mockResolvedValue('https://mock-r2.test/signed-url');
    restoreStorageClient = () => {
      (storage as unknown as { getClient: unknown }).getClient = original;
      signedUrlSpy.mockRestore();
    };
  }, 60_000);

  afterAll(async () => {
    restoreStorageClient();
    // cleanupTenant() deletes customer_files/ai_training_files/customers, all
    // scoped by tenantId, in FK-safe order.
    await cleanupTenant(e2e, owner.tenantId);
    await e2e.app.close();
  }, 60_000);

  describe('POST /uploads (storage.uploads_controller)', () => {
    const url = '/api/v1/uploads';

    it('accepts a legitimate authenticated + permissioned upload', async () => {
      await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .field('docType', 'commercial_registration')
        .attach('file', validPdf(), {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
    });

    it('rejects an excessively nested field name without consuming unbounded processing', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .field('docType', 'commercial_registration')
        .field(OVER_NESTED_FIELD_NAME, 'x')
        .attach('file', validPdf(), {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
        });
      // Asserts the SPECIFIC multer `LIMIT_FIELD_NESTING` signature
      // (`@nestjs/platform-express`'s `transformException` → `BadRequestException`
      // with this exact message), not merely "some 4xx" — the global
      // `ValidationPipe`'s `forbidNonWhitelisted` also 400s on an unexpected
      // field name for an unrelated reason, which would make a bare
      // status-code check pass even with the nesting bound absent (T029).
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Field name nesting too deep');
    });

    it('still rejects an oversized file', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .field('docType', 'commercial_registration')
        .attach('file', oversizedPdf(), {
          filename: 'big.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }, 30_000);

    it('still rejects a magic-byte / declared-MIME mismatch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .field('docType', 'commercial_registration')
        .attach('file', spoofedPdf(), {
          filename: 'fake.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /crm/customers/:customerId/files (crm.customer-file_controller)', () => {
    const url = () => `/api/v1/crm/customers/${customerId}/files`;

    it('accepts a legitimate authenticated + permissioned upload', async () => {
      await request(e2e.app.getHttpServer())
        .post(url())
        .set(...authHeader(owner.token))
        .field('fileName', 'Lab result')
        .attach('file', validPdf(), {
          filename: 'lab.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
    });

    it('rejects an excessively nested field name', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url())
        .set(...authHeader(owner.token))
        .field(OVER_NESTED_FIELD_NAME, 'x')
        .attach('file', validPdf(), {
          filename: 'lab.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Field name nesting too deep');
    });

    it('still rejects an oversized file', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url())
        .set(...authHeader(owner.token))
        .attach('file', oversizedPdf(), {
          filename: 'big.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }, 30_000);

    it('still rejects a magic-byte / declared-MIME mismatch', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url())
        .set(...authHeader(owner.token))
        .attach('file', spoofedPdf(), {
          filename: 'fake.pdf',
          contentType: 'application/pdf',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /ai/training-files/upload (ai.ai-training-file_controller)', () => {
    const url = '/api/v1/ai/training-files/upload';
    const validText = () =>
      Buffer.from('Clinic FAQ: we are open 9am-5pm, Sunday to Thursday.');

    it('accepts a legitimate authenticated + permissioned upload', async () => {
      await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .attach('file', validText(), {
          filename: 'faq.txt',
          contentType: 'text/plain',
        })
        .expect(201);
    });

    it('rejects an excessively nested field name', async () => {
      const res = await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .field(OVER_NESTED_FIELD_NAME, 'x')
        .attach('file', validText(), {
          filename: 'faq.txt',
          contentType: 'text/plain',
        });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Field name nesting too deep');
    });

    it('still rejects an oversized file', async () => {
      const oversizedText = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
      const res = await request(e2e.app.getHttpServer())
        .post(url)
        .set(...authHeader(owner.token))
        .attach('file', oversizedText, {
          filename: 'big.txt',
          contentType: 'text/plain',
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }, 30_000);
  });
});
