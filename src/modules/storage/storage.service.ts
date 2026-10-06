import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../../common/errors';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  DOCUMENT_UPLOAD_POLICY,
  UploadPolicy,
  assertPolicyContent,
  extensionMatchesMimeForPolicy,
  policyAllowsMime,
  policyExtensionForMime,
  sha256Hex,
} from './storage.constants';

export interface PutObjectInput {
  tenantId: string;
  /** Logical category — becomes the second path segment (sanitised). */
  docType: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

export interface StoredObject {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  /** SHA-256 hex digest of the uploaded bytes (server-computed). */
  sha256: string;
}

/**
 * Private object-storage gateway (AWS SDK v3). `STORAGE_PROVIDER` selects:
 *  - `s3` — Amazon S3. No endpoint and no static keys: credentials come from
 *    the SDK default chain, i.e. the ECS task role in AWS. Bucket default
 *    encryption (SSE-KMS) applies, so nothing here names a key.
 *  - `r2` (default, kept for rollback during the migration) — Cloudflare R2
 *    through its S3-compatible endpoint with static keys.
 * Keys are identical in both, so objects copy across without a DB rewrite.
 *
 * The bucket is PRIVATE: we store only object keys (never public URLs), and
 * reads are served through short-lived presigned GET URLs. The S3 client is
 * created lazily so the app boots fine in environments where storage is not
 * yet configured — only the upload/download/delete paths require it.
 *
 * Key layout: `<tenantId>/<docType>/<uuid>.<ext>`. The tenant prefix is the
 * tenant-isolation boundary — every read/delete asserts the caller owns the
 * prefix, so one clinic can never address another clinic's objects.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  private readonly provider: 'r2' | 's3';
  private readonly accountId: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly signedUrlTtl: number;

  constructor(config: ConfigService) {
    this.provider =
      config.get<string>('STORAGE_PROVIDER') === 's3' ? 's3' : 'r2';
    if (this.provider === 's3') {
      this.accountId = '';
      this.accessKeyId = '';
      this.secretAccessKey = '';
      this.bucket = config.get<string>('S3_BUCKET') ?? '';
      this.region =
        config.get<string>('S3_REGION') ||
        config.get<string>('AWS_REGION') ||
        '';
    } else {
      this.accountId = config.get<string>('R2_ACCOUNT_ID') ?? '';
      this.accessKeyId = config.get<string>('R2_ACCESS_KEY_ID') ?? '';
      this.secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY') ?? '';
      this.bucket = config.get<string>('R2_BUCKET') ?? '';
      this.region = config.get<string>('R2_REGION') || 'auto';
    }
    this.signedUrlTtl =
      config.get<number>('SIGNED_URL_EXPIRES_SECONDS') ??
      DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  /** Configured signed-URL lifetime (seconds). */
  get signedUrlTtlSeconds(): number {
    return this.signedUrlTtl;
  }

  /** Whether storage is configured. Routes guard on this for a clean 503. */
  isConfigured(): boolean {
    if (this.provider === 's3') return Boolean(this.bucket && this.region);
    return Boolean(
      this.accountId && this.accessKeyId && this.secretAccessKey && this.bucket,
    );
  }

  private getClient(): S3Client {
    if (!this.isConfigured()) {
      // Deliberately NOT a 503 — the frontend redirects all 503s to the
      // maintenance page, which would mask a configuration error. A 500 with a
      // clear message surfaces the real cause to operators.
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message:
          this.provider === 's3'
            ? 'File storage is not configured. Set S3_BUCKET and AWS_REGION (or S3_REGION).'
            : 'File storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
      });
    }
    if (!this.client) {
      this.client =
        this.provider === 's3'
          ? // Default credential chain → ECS task role. No keys to leak.
            new S3Client({ region: this.region })
          : new S3Client({
              region: this.region,
              endpoint: `https://${this.accountId}.r2.cloudflarestorage.com`,
              credentials: {
                accessKeyId: this.accessKeyId,
                secretAccessKey: this.secretAccessKey,
              },
            });
    }
    return this.client;
  }

  // ─────────────────────────── Key helpers ───────────────────────────────── //

  /** Lower-case slug safe for an object path segment. */
  private slug(value: string): string {
    return (
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'document'
    );
  }

  /** Strip any path component + unsafe chars from a user-supplied filename. */
  sanitizeFilename(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? name;
    const cleaned = base
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .replace(/_{2,}/g, '_');
    return cleaned.slice(0, 200) || 'file';
  }

  private buildKey(
    tenantId: string,
    docType: string,
    mimeType: string,
    policy: UploadPolicy = DOCUMENT_UPLOAD_POLICY,
  ): string {
    const ext = policyExtensionForMime(policy, mimeType);
    if (!ext) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Unsupported file type "${mimeType}".`,
      });
    }
    // The tenant prefix is the isolation boundary — see assertKeyBelongsToTenant.
    return `${tenantId}/${this.slug(docType)}/${randomUUID()}.${ext}`;
  }

  /**
   * Tenant isolation gate. A non-super-admin caller may only address objects
   * under their own `<tenantId>/` prefix; anything else is treated as not found
   * so we never confirm the existence of another tenant's object.
   */
  assertKeyBelongsToTenant(key: string, tenantId: string): void {
    const traversal = key.includes('..') || key.startsWith('/');
    if (traversal || !key.startsWith(`${tenantId}/`)) {
      throw new AppError(ErrorCode.NOT_FOUND, {
        message: 'Object not found',
      });
    }
  }

  // ─────────────────────────── Operations ────────────────────────────────── //

  /**
   * Stores an object under the tenant's prefix.
   *
   * `policy` decides what the object is ALLOWED to be. It defaults to
   * DOCUMENT_UPLOAD_POLICY, so every existing caller (verification documents)
   * keeps exactly its previous behaviour — four formats, magic-byte verified,
   * extension must match. WhatsApp media passes WHATSAPP_MEDIA_UPLOAD_POLICY
   * instead of loosening the document rules for everyone. See the policy
   * docs in storage.constants.ts for why the two differ.
   */
  async upload(
    input: PutObjectInput,
    policy: UploadPolicy = DOCUMENT_UPLOAD_POLICY,
  ): Promise<StoredObject> {
    if (!policyAllowsMime(policy, input.mimeType)) {
      const allowed = policy.allowedTypes.map((t) => t.mime).join(', ');
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: `Unsupported ${policy.name} type "${input.mimeType}". Allowed: ${allowed}.`,
      });
    }
    if (
      policy.requireExtensionMatch &&
      !extensionMatchesMimeForPolicy(input.originalName, input.mimeType, policy)
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'File extension does not match its content type.',
      });
    }
    if (!input.buffer || input.buffer.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Uploaded file is empty or corrupted.',
      });
    }
    // Defeat content-type spoofing & corruption: where we know the format's
    // signature the bytes must match it, under every policy.
    assertPolicyContent(input.buffer, input.mimeType, policy);

    const key = this.buildKey(
      input.tenantId,
      input.docType,
      input.mimeType,
      policy,
    );
    const sha256 = sha256Hex(input.buffer);

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.buffer,
        ContentType: input.mimeType,
        ContentLength: input.size,
        // Store the digest as object metadata for integrity checks / dedup.
        Metadata: { sha256 },
      }),
    );

    return {
      storageKey: key,
      filename: this.sanitizeFilename(input.originalName),
      mimeType: input.mimeType,
      size: input.size,
      sha256,
    };
  }

  /** Presigned GET URL for a private object — never cache or persist this. */
  async getSignedDownloadUrl(
    key: string,
    tenantId: string,
    expiresIn: number = this.signedUrlTtl,
  ): Promise<string> {
    this.assertKeyBelongsToTenant(key, tenantId);
    return getSignedUrl(
      this.getClient(),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.getClient().send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return false;
      // Unknown failure (network, credentials) — surface, don't silently pass.
      this.logger.error(
        `headObject failed for ${key}: ${(err as Error)?.message}`,
      );
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message: 'Could not verify the uploaded file in storage.',
        cause: err,
      });
    }
  }

  /** Server-side private read used by trusted ingestion pipelines. */
  async downloadObject(
    key: string,
    tenantId: string,
    maxBytes: number,
  ): Promise<Buffer> {
    this.assertKeyBelongsToTenant(key, tenantId);
    const head = await this.getClient().send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (
      (head.ContentLength ?? 0) <= 0 ||
      (head.ContentLength ?? 0) > maxBytes
    ) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Stored file is empty or exceeds the indexing size limit.',
      });
    }
    const result = await this.getClient().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body)
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Stored file has no readable body.',
      });
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) {
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'Stored file exceeds the indexing size limit.',
      });
    }
    return Buffer.from(bytes);
  }

  async deleteObject(key: string, tenantId: string): Promise<void> {
    this.assertKeyBelongsToTenant(key, tenantId);
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  /**
   * Erases an object PERMANENTLY, including every stored version and delete
   * marker (residency plan P11).
   *
   * Plain `deleteObject` is not erasure on a versioned bucket: S3 only writes a
   * delete marker and every earlier version stays readable to anyone who can ask
   * for it by version id. The uploads bucket is versioned, so a patient's
   * document survives `deleteObject` in full. This lists the key's versions and
   * removes each one.
   *
   * Providers without version listing (Cloudflare R2) answer the list call with
   * an error; those buckets have no versions, so the fallback is the plain
   * delete — which IS permanent there.
   */
  async purgeObject(
    key: string,
    tenantId: string,
  ): Promise<{ versionsRemoved: number }> {
    this.assertKeyBelongsToTenant(key, tenantId);
    const removed = await this.purgeVersionedPrefix(key, true);
    if (removed === null) {
      await this.getClient().send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { versionsRemoved: 1 };
    }
    return { versionsRemoved: removed };
  }

  /**
   * Erases EVERY object (all versions and delete markers) under a tenant's
   * `<tenantId>/` prefix — the storage leg of tenant offboarding. Returns the
   * number of versions removed. Throws on any batch failure so a partial purge is
   * never reported as complete.
   */
  async purgeTenantPrefix(
    tenantId: string,
  ): Promise<{ versionsRemoved: number }> {
    if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
      // The prefix is the only thing standing between this and the whole bucket.
      throw new AppError(ErrorCode.BAD_REQUEST, {
        message: 'A tenant id is required to purge a storage prefix.',
      });
    }
    const prefix = `${tenantId}/`;
    const removed = await this.purgeVersionedPrefix(prefix, false);
    if (removed !== null) return { versionsRemoved: removed };

    // No version listing: list current objects and delete them.
    const client = this.getClient();
    let total = 0;
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        await this.deleteBatch(keys);
        total += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return { versionsRemoved: total };
  }

  /**
   * Deletes every version and delete marker whose key matches `target`
   * (`exact`) or starts with it. Returns the count, or `null` when the provider
   * cannot list versions at all.
   */
  private async purgeVersionedPrefix(
    target: string,
    exact: boolean,
  ): Promise<number | null> {
    const client = this.getClient();
    let total = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      let page;
      try {
        page = await client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: target,
            KeyMarker: keyMarker,
            VersionIdMarker: versionMarker,
          }),
        );
      } catch (err) {
        const name = (err as { name?: string })?.name ?? '';
        // Only "this provider has no versioning API" selects the fallback;
        // anything else (denied, network) must surface, not silently degrade.
        if (
          total === 0 &&
          /NotImplemented|NotSupported|Unsupported/i.test(name)
        ) {
          return null;
        }
        throw err;
      }
      const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter((v) => v.Key && (!exact || v.Key === target))
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (entries.length > 0) {
        await this.deleteBatch(entries);
        total += entries.length;
      }
      if (!page.IsTruncated) return total;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }

  /** DeleteObjects takes at most 1000 keys; a per-key error is a failure of the purge. */
  private async deleteBatch(
    objects: Array<{ Key: string; VersionId?: string }>,
  ): Promise<void> {
    for (let i = 0; i < objects.length; i += 1000) {
      const result = await this.getClient().send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects.slice(i, i + 1000), Quiet: true },
        }),
      );
      if (result.Errors && result.Errors.length > 0) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, {
          message: `Storage purge failed for ${result.Errors.length} object(s).`,
        });
      }
    }
  }

  /**
   * Marketplace BE-3 (T099, contract C12) — server-side object STREAM read.
   * Distinct from `getSignedDownloadUrl` (a presigned URL — never appropriate
   * for a public-facing proxy, since it would hand the private bucket's URL
   * to the browser/CDN) and from `downloadObject` (buffers the whole object
   * into memory for a trusted server-side pipeline). The public avatar proxy
   * needs the bytes to forward, never the URL, so it streams straight
   * through instead of buffering.
   */
  async getObjectStream(
    key: string,
    tenantId: string,
  ): Promise<{
    body: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: number;
    etag?: string;
  }> {
    this.assertKeyBelongsToTenant(key, tenantId);
    let result: GetObjectCommandOutput;
    try {
      result = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // A referenced key with no live object behind it (deleted from the
      // bucket out from under a still-referencing row, or similar) is
      // "not found" to every caller, not a server failure — most visibly
      // for T099's public avatar proxy, where this must be the SAME 404 as
      // an ineligible/unknown doctor, never a raw 500 with provider detail.
      if ((err as { name?: string })?.name === 'NoSuchKey') {
        throw new AppError(ErrorCode.NOT_FOUND, {
          message: 'Object not found',
          cause: err,
        });
      }
      throw err;
    }
    if (!result.Body) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message: 'Stored object has no readable body.',
      });
    }
    return {
      body: result.Body as NodeJS.ReadableStream,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentLength: result.ContentLength,
      etag: result.ETag,
    };
  }
}
