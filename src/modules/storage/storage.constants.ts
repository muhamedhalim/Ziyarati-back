import { createHash } from 'node:crypto';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * `fieldNestingDepth` (multer@2.2.0+, ZT-004b — see research.md D3) is
 * enforced at runtime but not yet reflected in `@nestjs/platform-express`'s
 * bundled `MulterOptions['limits']` type as of 11.1.29 — only the `.d.ts`
 * lags, and that interface is not part of the package's exported public API
 * (only reachable via a non-exported deep path), so it cannot be imported
 * and extended directly. This local type mirrors busboy's own documented
 * limits shape (https://github.com/mscdex/busboy#exports) plus the missing
 * field, and is the single place that gap is bridged — reused by every
 * multipart upload route's `FileInterceptor` `limits` object rather than
 * repeating a type assertion at each of the three call sites.
 */
export interface MulterLimitsWithNestingDepth {
  fieldNameSize?: number;
  fieldSize?: number;
  fields?: number;
  fileSize?: number;
  files?: number;
  parts?: number;
  headerPairs?: number;
  fieldNestingDepth: number;
}

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

// ─── Upload policies ────────────────────────────────────────────────────────

/**
 * An upload policy: what a given KIND of object is allowed to be.
 *
 * The bucket serves two very different populations of file, and collapsing them
 * into one allow-list would mean loosening the strict one:
 *
 *  - DOCUMENT — tenant verification artefacts (CR, national ID, MoH licence).
 *    Uploaded by users, legally significant, so: four formats only, every one
 *    magic-byte verified, extension must agree with the MIME.
 *
 *  - WHATSAPP_MEDIA — files a patient sent to the clinic over WhatsApp.
 *    Fetched by us from Meta's API over TLS with the tenant's bearer token, so
 *    the file never transits an anonymous uploader and the declared MIME comes
 *    from Meta, not from a client. The realistic threat is "a patient sent
 *    something weird", not "an attacker is spoofing a content type at us".
 *    The allow-list therefore covers the media WhatsApp actually carries, and
 *    magic bytes are verified for every format we have a signature for
 *    (`requireMagicBytes: false` means "verify when known", not "never check").
 *    There is no filename/extension rule because WhatsApp media routinely
 *    arrives with no filename at all.
 */
export interface UploadPolicy {
  /** Human-readable name, used in error messages. */
  readonly name: string;
  readonly allowedTypes: readonly AllowedUploadType[];
  /** When true, an unverifiable format is rejected outright. */
  readonly requireMagicBytes: boolean;
  /** When true, the original filename's extension must match the MIME. */
  readonly requireExtensionMatch: boolean;
}

export const DOCUMENT_UPLOAD_POLICY: UploadPolicy = {
  name: 'document',
  allowedTypes: ALLOWED_UPLOAD_TYPES,
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

export const AI_TRAINING_UPLOAD_POLICY: UploadPolicy = {
  name: 'AI training text',
  allowedTypes: [
    { mime: 'text/plain', extensions: ['txt'] },
    { mime: 'text/markdown', extensions: ['md', 'markdown'] },
  ],
  // Plain text has no reliable magic bytes; strict MIME + extension + UTF-8
  // extraction validation is performed before indexing.
  requireMagicBytes: false,
  requireExtensionMatch: true,
};

/**
 * Files an ANONYMOUS visitor may attach to a public AI chat.
 *
 * This is the strictest population the bucket has, because it is the only one
 * an unauthenticated stranger can write to. It is a deliberate SUBSET of
 * `DOCUMENT_UPLOAD_POLICY` with identical enforcement (`requireMagicBytes` and
 * `requireExtensionMatch` both true) rather than a reuse of it, so that
 * loosening tenant document rules later can never silently loosen this one.
 *
 * Every accepted format has a magic-byte signature implemented in
 * `matchesSignature`, so `requireMagicBytes: true` is genuinely enforceable
 * here — a renamed `.exe`, a script, an archive or an Office document is
 * rejected on its bytes, not on the client's word about them.
 */
export const GUEST_CHAT_ATTACHMENT_UPLOAD_POLICY: UploadPolicy = {
  name: 'chat attachment',
  allowedTypes: [
    { mime: 'application/pdf', extensions: ['pdf'] },
    { mime: 'image/png', extensions: ['png'] },
    { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
    { mime: 'image/webp', extensions: ['webp'] },
  ],
  requireMagicBytes: true,
  requireExtensionMatch: true,
};

/**
 * Per-file cap for guest chat attachments (5 MB), independent of
 * `UPLOAD_MAX_BYTES` (10 MB) which governs authenticated tenant documents.
 * Anonymous writes get the tighter number; override with
 * `GUEST_ATTACHMENT_MAX_BYTES`.
 */
export const DEFAULT_GUEST_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export function resolveGuestAttachmentMaxBytes(): number {
  const raw = Number(process.env.GUEST_ATTACHMENT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_GUEST_ATTACHMENT_MAX_BYTES;
}

export const GUEST_ATTACHMENT_MAX_BYTES = resolveGuestAttachmentMaxBytes();

/** Media types WhatsApp can deliver inbound. Executables/archives are absent by design. */
export const WHATSAPP_MEDIA_UPLOAD_TYPES: readonly AllowedUploadType[] = [
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { mime: 'image/png', extensions: ['png'] },
  { mime: 'image/webp', extensions: ['webp'] },
  { mime: 'image/gif', extensions: ['gif'] },
  { mime: 'application/pdf', extensions: ['pdf'] },
  { mime: 'audio/aac', extensions: ['aac'] },
  { mime: 'audio/mp4', extensions: ['m4a'] },
  { mime: 'audio/mpeg', extensions: ['mp3'] },
  { mime: 'audio/amr', extensions: ['amr'] },
  { mime: 'audio/ogg', extensions: ['ogg'] },
  { mime: 'video/mp4', extensions: ['mp4'] },
  { mime: 'video/3gpp', extensions: ['3gp'] },
  { mime: 'text/plain', extensions: ['txt'] },
  { mime: 'application/msword', extensions: ['doc'] },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
  },
  { mime: 'application/vnd.ms-excel', extensions: ['xls'] },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
  },
] as const;

export const WHATSAPP_MEDIA_UPLOAD_POLICY: UploadPolicy = {
  name: 'WhatsApp media',
  allowedTypes: WHATSAPP_MEDIA_UPLOAD_TYPES,
  requireMagicBytes: false,
  requireExtensionMatch: false,
};

export function policyAllowsMime(policy: UploadPolicy, mime: string): boolean {
  return policy.allowedTypes.some((t) => t.mime === mime);
}

/** Preferred storage extension for a MIME under a policy. */
export function policyExtensionForMime(
  policy: UploadPolicy,
  mime: string,
): string | null {
  return (
    policy.allowedTypes.find((t) => t.mime === mime)?.extensions[0] ?? null
  );
}

/**
 * Enforces a policy's content rules on a buffer.
 *
 * Magic bytes are checked whenever a signature is KNOWN, under every policy —
 * a relaxed policy only decides what happens for formats we cannot verify
 * (reject vs. accept), never whether to skip a check we could have made.
 */
export function assertPolicyContent(
  buffer: Buffer,
  mime: string,
  policy: UploadPolicy,
): void {
  if (hasSignature(mime)) {
    assertMagicBytes(buffer, mime);
    return;
  }
  if (policy.requireMagicBytes) {
    throw new AppError(ErrorCode.BAD_REQUEST, {
      message: `File type "${mime}" cannot be content-verified and is not accepted.`,
    });
  }
}

/** True when `matchesSignature` knows this MIME's magic number. */
export function hasSignature(mime: string): boolean {
  return SIGNED_MIMES.has(mime);
}

const SIGNED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

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

export function extensionMatchesMimeForPolicy(
  filename: string,
  mime: string,
  policy: UploadPolicy,
): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = normalizeExtension(filename.slice(dot + 1));
  const type = policy.allowedTypes.find((t) => t.mime === mime);
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
        buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
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
    case 'image/gif':
      // "GIF87a" / "GIF89a"
      return (
        buf[0] === 0x47 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x38 &&
        (buf[4] === 0x37 || buf[4] === 0x39) &&
        buf[5] === 0x61
      );
    default:
      return false;
  }
}
