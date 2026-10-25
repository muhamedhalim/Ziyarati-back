import type { NextFunction, Request, Response } from 'express';

/**
 * Refuses request bodies sent with `Content-Encoding: br`.
 *
 * body-parser 2.x decompresses `br` request bodies with `node:zlib`'s Brotli
 * decoder BEFORE any guard runs, so every unauthenticated POST can feed
 * attacker bytes straight into it. CVE-2026-111497 (Node.js 2026-10-21
 * security release, fixed in 24.22.1) is an out-of-bounds write in exactly
 * that decoder. Upgrading the runtime is the fix; this keeps the decoder off
 * the pre-auth path regardless of which runtime an image (or a rollback
 * image) ships with. No client of this API compresses request bodies with
 * Brotli — browsers never compress requests, and the Meta / Tap / SNS
 * webhooks send identity bodies — while gzip/deflate keep working.
 *
 * Must be registered with `app.use()` before Nest initialises, so it runs
 * ahead of the body parsers Nest installs at init. The error mirrors
 * body-parser's own `encoding.unsupported` 415, so the exception filter
 * answers it the same way.
 */
export function rejectBrotliRequestBody(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['content-encoding'];
  const tokens = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((t) => t.trim().toLowerCase());
  if (tokens.includes('br')) {
    next(
      Object.assign(new Error('unsupported content encoding "br"'), {
        status: 415,
        statusCode: 415,
        expose: true,
        type: 'encoding.unsupported',
        encoding: 'br',
      }),
    );
    return;
  }
  next();
}
