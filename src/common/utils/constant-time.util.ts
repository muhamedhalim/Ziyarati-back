import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality for two UTF-8 strings holding a shared secret
 * (a CSRF token, a webhook verify token, …). Never short-circuits on a
 * length mismatch: both inputs are first reduced to a fixed-length SHA-256
 * digest, so `timingSafeEqual` always compares two 32-byte buffers and the
 * total work done — hash + compare — is independent of either input's
 * length or content, unlike a direct `a === b` (which returns instantly on
 * the first differing byte, or on a length mismatch) or a raw
 * `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` (which throws on
 * unequal-length buffers, forcing callers to add their own length
 * short-circuit before it — the exact leak this function exists to avoid).
 *
 * Two equal-content strings of different original length are never
 * possible by definition; two empty strings compare equal (both hash to
 * the same constant SHA-256 digest) — callers that must reject an absent
 * token do so themselves before calling this (see `csrf.guard.ts`, which
 * already requires both operands to be truthy first).
 *
 * Never logs either operand.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
