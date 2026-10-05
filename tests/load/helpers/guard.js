/**
 * TARGET GUARD — makes it impossible to point this suite at a real environment
 * by accident.
 *
 * Layer 1 (init context, pure string check, runs the moment any helper imports
 * this file): the BASE_URL host must be loopback / private-range / a name that
 * cannot resolve publicly, OR be explicitly allow-listed AND confirmed:
 *
 *   LOADTEST_ALLOWED_HOSTS=lab-api.internal.example      (comma list)
 *   LOADTEST_CONFIRM_TARGET=lab-api.internal.example     (must equal the host)
 *
 * A deny-list of known production domains / hosting suffixes wins over every
 * allow rule, so even a mistyped allow-list cannot authorise them.
 *
 * Layer 2 (setup(), via preflight()): the live target must look like a
 * non-production API. Production refuses an unauthenticated /api/v1/metrics
 * (METRICS_TOKEN is mandatory there), so a 200 proves a non-production boot.
 *
 * Nothing here prints a credential. The full pre-run checks (database name,
 * sentinel row, process-environment audit) live in lab/run-campaign.mjs.
 */
import http from 'k6/http';
import exec from 'k6/execution';

export const TARGET = __ENV.BASE_URL || 'http://host.docker.internal:3001';

const DENY = [
  'ziyaratech', 'ziyarati.com', 'railway.app', 'vercel.app', 'amazonaws.com',
  'cloudfront.net', 'onrender.com', 'fly.dev', 'herokuapp.com', 'azurewebsites.net',
  'run.app', 'cloudflare', 'netlify.app', 'digitaloceanspaces.com',
];

export function hostOf(url) {
  const m = /^https?:\/\/(\[[^\]]+\]|[^\/:?#]+)(?::\d+)?/i.exec(String(url));
  return m ? m[1].toLowerCase().replace(/^\[|\]$/g, '') : '';
}

function isPrivateHost(h) {
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === 'host.docker.internal') return true;
  // `.localhost` / `.test` can never resolve publicly (RFC 6761). `.internal` and
  // `.local` CAN resolve inside real cloud networks, so they need the allow-list.
  if (/\.(localhost|test)$/.test(h)) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

export function assertSafeHost(url) {
  const h = hostOf(url);
  if (!h) throw new Error(`[target-guard] BASE_URL is not a valid http(s) URL`);
  for (const bad of DENY) {
    if (h.indexOf(bad) !== -1) {
      throw new Error(`[target-guard] REFUSED: host "${h}" matches a protected domain (${bad}).`);
    }
  }
  if (isPrivateHost(h)) return h;
  const allowed = String(__ENV.LOADTEST_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const confirm = String(__ENV.LOADTEST_CONFIRM_TARGET || '').trim().toLowerCase();
  if (allowed.indexOf(h) === -1 || confirm !== h) {
    throw new Error(
      `[target-guard] REFUSED: host "${h}" is not loopback/private. A non-local lab host needs BOTH ` +
      `LOADTEST_ALLOWED_HOSTS and LOADTEST_CONFIRM_TARGET set to exactly that host.`,
    );
  }
  return h;
}

// Layer 1 — evaluated at import, before any VU can send a request.
assertSafeHost(TARGET);

/** Layer 2 — call from setup(). Aborts the whole run if the target looks like production. */
export function preflight() {
  if (__ENV.LT_SKIP_PREFLIGHT === 'true') return;
  const ready = http.get(`${TARGET}/api/v1/system/health/readiness`, { tags: { name: 'preflight/readiness' } });
  if (ready.status !== 200) {
    exec.test.abort(`[target-guard] readiness returned ${ready.status}; refusing to run against an unhealthy or wrong target`);
  }
  const metrics = http.get(`${TARGET}/api/v1/metrics`, { tags: { name: 'preflight/metrics' } });
  if (metrics.status !== 200) {
    exec.test.abort(
      `[target-guard] /api/v1/metrics answered ${metrics.status} without a token — this is how a PRODUCTION ` +
      `boot behaves. Refusing to run. (Set LT_SKIP_PREFLIGHT=true only for a lab that sets METRICS_TOKEN.)`,
    );
  }
}
