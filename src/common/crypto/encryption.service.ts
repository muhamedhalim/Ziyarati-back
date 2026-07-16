import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { AppError, ErrorCode } from '../errors';

/**
 * Envelope prefix for ciphertext produced by this service. It exists so a value
 * read back from the database is self-describing: anything NOT carrying this
 * prefix is legacy plaintext (see `decrypt`), which is what makes the
 * encrypt-at-rest migration safe to roll out without a flag day.
 *
 * Bump the version suffix if the algorithm or key derivation ever changes — old
 * rows keep decrypting under their own version.
 */
const ENVELOPE_V1 = 'enc:v1:';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // aes-256
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const AUTH_TAG_BYTES = 16;

/**
 * Symmetric encryption for secrets we must store and later re-read in plaintext
 * to use (provider access tokens), as opposed to secrets we only ever need to
 * compare (passwords — those are hashed elsewhere, never handled here).
 *
 * AES-256-GCM is authenticated: tampering with a stored ciphertext makes
 * `decrypt` throw rather than silently returning corrupt bytes.
 *
 * Format: `enc:v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>`. A fresh random IV is
 * generated per call, so encrypting the same token twice yields different
 * ciphertext — do NOT use these values for equality comparison or lookups.
 *
 * The key comes from CREDENTIALS_ENCRYPTION_KEY (base64 or hex, 32 bytes). It is
 * validated at boot (`onModuleInit`) so a misconfigured key fails the deploy
 * instead of failing every send at runtime.
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger('EncryptionService');
  private key: Buffer | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // Resolve once at boot: a bad key is a deploy-time failure, not a
    // per-request surprise. Services that never touch secrets are unaffected
    // because `configured` stays false and only encrypt/decrypt throw.
    this.key = this.loadKey();
    if (this.key) {
      this.logger.log('Credential encryption is ACTIVE (aes-256-gcm)');
    } else {
      this.logger.warn(
        'CREDENTIALS_ENCRYPTION_KEY is not set — provider credentials cannot be encrypted or read. ' +
          'Set it to a 32-byte base64 or hex key.',
      );
    }
  }

  /** Whether a usable key is configured (callers can degrade/skip accordingly). */
  get configured(): boolean {
    return this.key !== null;
  }

  /**
   * Encrypts a plaintext secret into the versioned envelope.
   * Returns `null`/`undefined` unchanged so optional columns stay optional.
   */
  encrypt(plaintext: string): string;
  encrypt(plaintext: string | undefined): string | undefined;
  encrypt(plaintext: string | null): string | null;
  encrypt(plaintext: string | null | undefined): string | null | undefined {
    if (plaintext === null || plaintext === undefined || plaintext === '') {
      return plaintext;
    }
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return [
      ENVELOPE_V1 + iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  /**
   * Decrypts a value produced by `encrypt`.
   *
   * LEGACY TOLERANCE: a value without the envelope prefix is returned as-is and
   * assumed to be pre-encryption plaintext. This is what lets the backfill
   * migration and the application roll out independently; once no unprefixed
   * rows remain, this branch is dead and can be removed.
   */
  decrypt(value: string): string;
  decrypt(value: string | undefined): string | undefined;
  decrypt(value: string | null): string | null;
  decrypt(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined || value === '') {
      return value;
    }
    if (!this.isEncrypted(value)) {
      return value;
    }

    const key = this.requireKey();
    const [ivB64, tagB64, dataB64] = value.slice(ENVELOPE_V1.length).split(':');
    if (!ivB64 || !tagB64 || !dataB64) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message: 'Stored credential is malformed and cannot be decrypted',
      });
    }

    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Authentication failure = wrong key or tampered ciphertext. Never echo
      // the value or the underlying error (both leak information about the key).
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message: 'Stored credential could not be decrypted (wrong key or tampered data)',
      });
    }
  }

  /** True if `value` carries this service's envelope (i.e. is already encrypted). */
  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENVELOPE_V1);
  }

  // ──────────────────────────── Private helpers ──────────────────────────── //

  private requireKey(): Buffer {
    // `onModuleInit` normally populates this; the fallback covers direct
    // instantiation in tests and any provider constructed before init.
    const key = this.key ?? (this.key = this.loadKey());
    if (!key) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, {
        message:
          'CREDENTIALS_ENCRYPTION_KEY is not configured — cannot handle provider credentials',
      });
    }
    return key;
  }

  /** Parses the configured key, accepting base64 or hex. Null when unset. */
  private loadKey(): Buffer | null {
    const raw = this.config.get<string>('CREDENTIALS_ENCRYPTION_KEY')?.trim();
    if (!raw) return null;

    const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');

    if (decoded.length !== KEY_BYTES) {
      // Fail loudly at boot rather than encrypting under a weak/short key.
      throw new Error(
        `CREDENTIALS_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes ` +
          `(got ${decoded.length}). Generate one with: openssl rand -base64 32`,
      );
    }
    return decoded;
  }

  /**
   * Constant-time equality for two secrets. Exposed because comparing decrypted
   * credentials with `===` leaks length/prefix information through timing.
   */
  static secretEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }
}

/** Exported for tests + the backfill migration, which must agree on the format. */
export const ENCRYPTION_ENVELOPE_PREFIX = ENVELOPE_V1;
export const ENCRYPTION_AUTH_TAG_BYTES = AUTH_TAG_BYTES;
