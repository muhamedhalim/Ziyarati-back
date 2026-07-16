import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'node:crypto';

import { AppError, ErrorCode } from '../../common/errors';
import {
  DEFAULT_SIGNED_URL_TTL_SECONDS,
  DOCUMENT_UPLOAD_POLICY,
  UploadPolicy,
  assertPolicyContent,
  extensionMatchesMime,
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
 * Cloudflare R2 storage gateway (S3-compatible, AWS SDK v3).
 *
 * The bucket is PRIVATE: we store only object keys (never public URLs), and
 * reads are served through short-lived presigned GET URLs. The S3 client is
 * created lazily so the app boots fine in environments where R2 is not yet
 * configured — only the upload/download/delete paths require the credentials.
 *
 * Key layout: `<tenantId>/<docType>/<uuid>.<ext>`. The tenant prefix is the
 * tenant-isolation boundary — every read/delete asserts the caller owns the
 * prefix, so one clinic can never address another clinic's objects.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;

  private readonly accountId: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;
  private readonly region: string;
  private readonly signedUrlTtl: number;

  constructor(config: ConfigService) {
    this.accountId = config.get<string>('R2_ACCOUNT_ID') ?? '';
    this.accessKeyId = config.get<string>('R2_ACCESS_KEY_ID') ?? '';
    this.secretAccessKey = config.get<string>('R2_SECRET_ACCESS_KEY') ?? '';
    this.bucket = config.get<string>('R2_BUCKET') ?? '';
    this.region = config.get<string>('R2_REGION') || 'auto';
    this.signedUrlTtl =
      config.get<number>('SIGNED_URL_EXPIRES_SECONDS') ??
      DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  /** Configured signed-URL lifetime (seconds). */
  get signedUrlTtlSeconds(): number {
    return this.signedUrlTtl;
  }

  /** Whether R2 credentials are present. Routes guard on this for a clean 503. */
  isConfigured(): boolean {
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
          'File storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
      });
    }
    if (!this.client) {
      this.client = new S3Client({
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
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
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
      !extensionMatchesMime(input.originalName, input.mimeType)
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

    const key = this.buildKey(input.tenantId, input.docType, input.mimeType, policy);
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
    expiresIn: number = this.signedUrlTtl,
  ): Promise<string> {
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

  async deleteObject(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
