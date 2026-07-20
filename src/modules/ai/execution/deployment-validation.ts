/**
 * Validation for per-tenant regional AI deployment settings (Data Residency).
 *
 * The base URL is attacker-influenced data (it drives outbound HTTP from our
 * servers), so it must be validated to block SSRF to internal/metadata hosts.
 * These are pure functions so they can be reused by any write path (a future
 * admin endpoint) AND enforced defensively at the point of use in
 * AiDataResidencyService.
 */

/** Region label: short, `[a-z0-9-]`, e.g. "eu", "us-east". */
export function isValidRegion(region: string): boolean {
  return (
    /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(region) ||
    /^[a-z0-9]$/.test(region)
  );
}

/** OpenAI project id: `proj_...` or a conservative token. */
export function isValidProject(project: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(project);
}

/** IPv4 in a private / loopback / link-local / CGNAT range (SSRF blocklist). */
function isBlockedIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, Number(m[3]), Number(m[4])].some((n) => n > 255) || a > 255)
    return true; // malformed → block
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/**
 * Throws when the base URL is not a safe, external https endpoint. Blocks
 * non-https schemes, credentials in the URL, loopback/private/link-local hosts,
 * IPv6 loopback/link-local/ULA, and bare `*.internal`/`.local` names.
 */
export function assertSafeDeploymentBaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('base URL is not a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('base URL must use https');
  if (url.username || url.password)
    throw new Error('base URL must not contain credentials');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost'))
    throw new Error('base URL host is loopback');
  if (host.endsWith('.internal') || host.endsWith('.local'))
    throw new Error('base URL host is internal');
  if (isBlockedIpv4(host))
    throw new Error('base URL host is a private/loopback IP');
  // IPv6 loopback (::1), link-local (fe80::/10), unique-local (fc00::/7).
  if (host === '::1' || host === '::')
    throw new Error('base URL host is IPv6 loopback');
  if (
    host.startsWith('fe8') ||
    host.startsWith('fe9') ||
    host.startsWith('fea') ||
    host.startsWith('feb')
  ) {
    throw new Error('base URL host is IPv6 link-local');
  }
  if (host.startsWith('fc') || host.startsWith('fd'))
    throw new Error('base URL host is IPv6 ULA');
}
