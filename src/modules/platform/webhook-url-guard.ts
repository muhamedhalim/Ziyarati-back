import { AppError, ErrorCode } from '../../common/errors';

/**
 * SSRF guard for tenant-supplied outbound webhook endpoint URLs.
 *
 * Deliberately independent from `modules/ai/execution/deployment-validation
 * .ts`'s `assertSafeDeploymentBaseUrl` rather than reusing it: that validator
 * is https-only (a stricter policy appropriate for AI provider deployments),
 * while webhook endpoints must allow plain http too (many self-hosted clinic
 * systems have no TLS) — extracting a shared core for two callers that want
 * different protocol policies would be more coupling than the ~30 lines of
 * duplicated IP-range logic are worth. The blocked-range list is the same
 * well-known SSRF set (private/loopback/link-local/CGNAT/cloud-metadata).
 *
 * KNOWN LIMITATION (documented, not fixed here): this validates the URL's
 * literal hostname/IP only, with no DNS resolution. A hostname that resolves
 * to a private IP only at request time (DNS rebinding) would pass this check
 * — Node's `fetch` does not re-validate the resolved socket address. Full
 * mitigation would require a custom resolving `Agent`/dispatcher, which is a
 * larger change out of scope for Phase 2.
 */

/** IPv4 in a private / loopback / link-local / CGNAT range. */
function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => n > 255)) return true; // malformed → block
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Ports commonly used by internal services — blocked so a public IP fronting
 * an internal service on a non-web port can't be used as an SSRF pivot. Not
 * exhaustive; the primary defense is the IP-range check above, this is
 * defense-in-depth.
 */
const DANGEROUS_PORTS = new Set([
  22, 23, 25, 53, 110, 135, 139, 143, 161, 389, 445, 512, 513, 514,
  1433, 1521, 2375, 2376, 3306, 3389, 5432, 5984, 6379, 8500, 9200,
  11211, 27017,
]);

export function assertSafeWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message: 'Webhook URL is not a valid URL' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Webhook URL must use http or https',
    });
  }
  if (url.username || url.password) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: 'Webhook URL must not contain credentials',
    });
  }

  if (url.port) {
    const port = Number(url.port);
    if (DANGEROUS_PORTS.has(port)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, {
        message: `Webhook URL port ${port} is not allowed`,
      });
    }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const fail = (message: string): never => {
    throw new AppError(ErrorCode.VALIDATION_ERROR, { message });
  };

  if (host === 'localhost' || host.endsWith('.localhost')) fail('Webhook URL host is loopback');
  if (host.endsWith('.internal') || host.endsWith('.local')) fail('Webhook URL host is internal');
  if (isBlockedIpv4(host)) fail('Webhook URL host is a private/loopback IP');
  // IPv6 loopback (::1), unspecified (::), link-local (fe80::/10), unique-local (fc00::/7).
  if (host === '::1' || host === '::') fail('Webhook URL host is IPv6 loopback');
  if (['fe8', 'fe9', 'fea', 'feb'].some((p) => host.startsWith(p))) {
    fail('Webhook URL host is IPv6 link-local');
  }
  if (host.startsWith('fc') || host.startsWith('fd')) fail('Webhook URL host is IPv6 ULA');
}
