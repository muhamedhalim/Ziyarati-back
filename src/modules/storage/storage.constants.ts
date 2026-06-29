import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * Allow-list and limits for tenant document uploads.
 *
 * Verification documents are legal artefacts (CR, national ID, MoH license, …)
 * supplied as PDFs or scans. We deliberately accept ONLY these four content
 * types — anything executable or unexpected is rejected before it ever reaches
 * the bucket. The MIME is authoritative for the stored extension; the original
 * filename's extension is validated separately to defeat double-extension
 * tricks (e.g. `passport.pdf.exe`).
 */

export interface AllowedUploadType {
  /** Canonical MIME the client must send. */
  mime: string;
  /** Extensions that legitimately map to this MIME (lower-case, no dot). */
  extensions: string[];
}

export const ALLOWED_UPLOAD_TYPES: readonly AllowedUploadType[] = [
  { mime: 'application/pdf', extensions: ['pdf'] },
  { mime: 'image/png', extensions: ['png'] },
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { mime: 'image/webp', extensions: ['webp'] },
] as const;

export const ALLOWED_MIME_TYPES: readonly string[] = ALLOWED_UPLOAD_TYPES.map(
  (t) => t.mime,
);

export const ALLOWED_EXTENSIONS: readonly string[] =
  ALLOWED_UPLOAD_TYPES.flatMap((t) => t.extensions);

/** Default hard cap on a single upload (10 MB). Override with `UPLOAD_MAX_BYTES`. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Resolved upload size cap. Read from `UPLOAD_MAX_BYTES` at module load so it can
 * be referenced both in the multer interceptor limit (decorator-time) and in the
 * controller's explicit boundary check.
 */
export function resolveMaxUploadBytes(): number {
  const raw = Number(process.env.UPLOAD_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_UPLOAD_BYTES;
}

export const MAX_UPLOAD_BYTES = resolveMaxUploadBytes();

/** Default signed-URL lifetime for private reads (5 min). Override with `SIGNED_URL_EXPIRES_SECONDS`. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 5 * 60;

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_TYPES.includes(mime);
}

export function normalizeExtension(ext: string): string {
  return ext.toLowerCase().replace(/^\.+/, '');
}

export function isAllowedExtension(ext: string): boolean {
  return ALLOWED_EXTENSIONS.includes(normalizeExtension(ext));
}

/** Preferred storage extension for a MIME (first in its extension list). */
export function extensionForMime(mime: string): string | null {
  const type = ALLOWED_UPLOAD_TYPES.find((t) => t.mime === mime);
  return type ? type.extensions[0] : null;
}

/** True when the original filename's extension is consistent with its MIME. */
export function extensionMatchesMime(filename: string, mime: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = normalizeExtension(filename.slice(dot + 1));
  const type = ALLOWED_UPLOAD_TYPES.find((t) => t.mime === mime);
  return !!type && type.extensions.includes(ext);
}

/** SHA-256 hex digest of a buffer. */
export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validates that a buffer's leading bytes match the magic number for its
 * declared MIME. This catches content-type spoofing (e.g. an `.exe` renamed to
 * `.pdf`) and truncated/corrupted uploads that no longer parse as the format.
 */
export function assertMagicBytes(buffer: Buffer, mime: string): void {
  const ok = matchesSignature(buffer, mime);
  if (!ok) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message:
        'File content does not match its declared type, or the file is corrupted.',
    });
  }
}

function matchesSignature(buf: Buffer, mime: string): boolean {
  if (buf.length < 12) return false;
  switch (mime) {
    case 'application/pdf':
      // "%PDF"
      return (
        buf[0] === 0x25 &&
        buf[1] === 0x50 &&
        buf[2] === 0x44 &&
        buf[3] === 0x46
      );
    case 'image/png':
      // \x89 P N G \r \n \x1a \n
      return (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    case 'image/jpeg':
      // FF D8 FF
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'image/webp':
      // "RIFF" .... "WEBP"
      return (
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      );
    default:
      return false;
  }
}
