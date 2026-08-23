import type { Request } from 'express';

/**
 * Reads the httpOnly `guest_token` cookie.
 *
 * Falls back to parsing the raw `Cookie` header because `cookie-parser` is not
 * guaranteed to have run on every path this is reached from (the same reason
 * `WsAuthService` parses the handshake header by hand). Extracted from
 * `GuestChatController` when a second public route needed the identical read —
 * two copies of a credential-extraction routine is exactly the kind of
 * duplication that drifts.
 */
export function readGuestTokenCookie(req: Request): string | undefined {
  const fromParser = (req as unknown as { cookies?: Record<string, string> })
    .cookies?.guest_token;
  if (fromParser) return fromParser;
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'guest_token') return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
