import { createHmac } from 'node:crypto';

import type { PaymentsConfig } from '../payments.config';
import { TapWebhookVerifier } from '../webhooks/tap-webhook.verifier';

/**
 * Go-live preflight for the Tap integration (Phase 8).
 *
 * Runs INSIDE the deployed image against the environment the service will
 * really boot with (a one-off ECS task with the API task definition), so it
 * answers the questions a sandbox run cannot: are the injected secrets the
 * right ones, does the live key actually authenticate, is the webhook URL
 * reachable through the ALB/WAF, is the frontend release with the pay pages
 * deployed. It is READ-ONLY toward Tap and toward our database; the only write
 * it can cause is the one explicit, opt-in webhook probe, which leaves a single
 * `FAILED` row in `webhook_logs` ("Re-fetch failed") and moves no money.
 *
 * Secret hygiene: it never prints a key, a signature or an env value other than
 * names, booleans and the key CLASS (`sk_live_` / `sk_test_`).
 *
 * What it can NOT prove (so nobody over-reads a green run): that Tap's own
 * `hashstring` formula matches ours. The webhook probe signs with OUR copy of
 * the formula, so it proves routing + the deployed secret + fail-closed
 * behaviour. Tap's real algorithm is only settled by a real delivery (Phase 7
 * operator step 2, or the first live 1-SAR smoke).
 */

export type PreflightStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  detail: string;
}

export interface PreflightReport {
  /** True when no check FAILed (WARN and SKIP do not fail the run). */
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightOptions {
  /** POST a signed + an unsigned synthetic webhook to TAP_WEBHOOK_URL. */
  probeWebhook: boolean;
  /** GET `${APP_URL}/pay/return` — proves the frontend release is deployed. */
  checkFrontend: boolean;
  /** FAIL (instead of SKIP) when PAYMENT_PROVIDER is not `tap`. */
  expectActive: boolean;
  /** FAIL when TAP_ENV is not this value. */
  expectEnv?: 'sandbox' | 'live';
  /** FAIL when TAP_RECURRING_ENABLED or TAP_BOOKING_PAYMENTS_ENABLED is on. */
  expectFlagsOff: boolean;
  timeoutMs: number;
}

export interface PreflightDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  /** The app's own Joi + fail-fast validation; throws with the boot error. */
  validate?: (env: Record<string, unknown>) => unknown;
}

export const DEFAULT_PREFLIGHT_OPTIONS: PreflightOptions = {
  probeWebhook: false,
  checkFrontend: true,
  expectActive: false,
  expectFlagsOff: false,
  timeoutMs: 15_000,
};

/** Well-formed but non-existent: Tap answers `400/1144` once the key is accepted. */
const UNKNOWN_CHARGE_ID = 'chg_TS00000000000000000000';
/** Auth is checked before the id, so either answer proves the key works. */
const KEY_ACCEPTED_CODES = new Set(['1144', '9997']);
/** `1101` key/env mismatch, `2104`/`2106` credentials (Tap error-code tables). */
const KEY_REJECTED_CODES = new Set(['1101', '2104', '2106']);
const WEBHOOK_PATH_SUFFIX = '/payments/webhooks/tap';

export async function runTapPreflight(
  deps: PreflightDeps,
  options: Partial<PreflightOptions> = {},
): Promise<PreflightReport> {
  const opts = { ...DEFAULT_PREFLIGHT_OPTIONS, ...options };
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string) =>
    checks.push({ id, status, detail });

  const val = (name: string): string | undefined => {
    const v = deps.env[name]?.trim();
    return v ? v : undefined;
  };
  const flagOn = (name: string): boolean => val(name)?.toLowerCase() === 'true';

  const production = val('NODE_ENV') === 'production';
  const provider = (val('PAYMENT_PROVIDER') ?? 'tap').toLowerCase();
  const tapEnv: 'sandbox' | 'live' =
    val('TAP_ENV')?.toLowerCase() === 'live' ? 'live' : 'sandbox';
  const secretName =
    tapEnv === 'live' ? 'TAP_LIVE_SECRET_KEY' : 'TAP_TEST_SECRET_KEY';
  const otherSecretName =
    tapEnv === 'live' ? 'TAP_TEST_SECRET_KEY' : 'TAP_LIVE_SECRET_KEY';
  const secret = val(secretName);
  const active = provider === 'tap';

  // 1 ── the application's own boot-time validation ──────────────────────────
  if (deps.validate) {
    try {
      deps.validate({ ...deps.env });
      add(
        'env-validation',
        'PASS',
        'the application would pass its boot validation',
      );
    } catch (err) {
      add(
        'env-validation',
        'FAIL',
        `the application would REFUSE to boot: ${firstLine((err as Error)?.message)}`,
      );
    }
  } else {
    add('env-validation', 'SKIP', 'no validator supplied');
  }

  // 2 ── provider selection ───────────────────────────────────────────────────
  if (active) {
    add('provider', 'PASS', 'PAYMENT_PROVIDER=tap');
  } else {
    add(
      'provider',
      opts.expectActive ? 'FAIL' : 'SKIP',
      `PAYMENT_PROVIDER is "${provider}"${
        opts.expectActive
          ? ', but Tap was expected to be active'
          : ' — Tap checks skipped (dark deploy)'
      }`,
    );
  }

  // 3 ── environment ──────────────────────────────────────────────────────────
  if (active) {
    if (!val('TAP_ENV')) {
      add(
        'tap-env',
        production ? 'FAIL' : 'WARN',
        'TAP_ENV is not set (defaults to sandbox)',
      );
    } else if (opts.expectEnv && tapEnv !== opts.expectEnv) {
      add(
        'tap-env',
        'FAIL',
        `TAP_ENV is "${tapEnv}", expected "${opts.expectEnv}"`,
      );
    } else if (production && tapEnv === 'sandbox') {
      add(
        'tap-env',
        'WARN',
        'production is running on SANDBOX keys — no real money can move',
      );
    } else if (!production && tapEnv === 'live') {
      add('tap-env', 'WARN', 'a LIVE key is active outside production');
    } else {
      add('tap-env', 'PASS', `TAP_ENV=${tapEnv}`);
    }
  } else {
    add('tap-env', 'SKIP', 'Tap not active');
  }

  // 4 ── keys ─────────────────────────────────────────────────────────────────
  if (active) {
    const prefix = tapEnv === 'live' ? 'sk_live_' : 'sk_test_';
    if (!secret) {
      add('tap-key', 'FAIL', `${secretName} is not set`);
    } else if (!secret.startsWith(prefix)) {
      add('tap-key', 'FAIL', `${secretName} does not start with "${prefix}"`);
    } else {
      add('tap-key', 'PASS', `${secretName} present (${prefix}…)`);
    }
    if (production && val(otherSecretName)) {
      add(
        'tap-key-other-env',
        'WARN',
        `${otherSecretName} is also injected — production should carry only the ${tapEnv} key`,
      );
    }
    add(
      'tap-merchant',
      val('TAP_MERCHANT_ID') ? 'PASS' : 'FAIL',
      val('TAP_MERCHANT_ID')
        ? 'TAP_MERCHANT_ID set'
        : 'TAP_MERCHANT_ID is not set',
    );
  }

  // 5 ── webhook URL ──────────────────────────────────────────────────────────
  const webhookUrl = val('TAP_WEBHOOK_URL');
  if (active) {
    add('webhook-url', ...webhookUrlVerdict(webhookUrl, production));
  }

  // 6 ── flags ────────────────────────────────────────────────────────────────
  if (active) {
    const recurring = flagOn('TAP_RECURRING_ENABLED');
    const booking = flagOn('TAP_BOOKING_PAYMENTS_ENABLED');
    const state = `TAP_RECURRING_ENABLED=${recurring}, TAP_BOOKING_PAYMENTS_ENABLED=${booking}`;
    if (booking && !val('TAP_PLATFORM_ID')) {
      add('flags', 'FAIL', `${state} — booking payments need TAP_PLATFORM_ID`);
    } else if (opts.expectFlagsOff && (recurring || booking)) {
      add('flags', 'FAIL', `${state} — expected both OFF at this stage`);
    } else {
      add('flags', 'PASS', state);
    }
  }

  // 7 ── the key authenticates against the real environment ─────────────────
  if (active && secret) {
    add('tap-auth', ...(await tapAuthVerdict(deps, opts, secret)));
  } else if (active) {
    add('tap-auth', 'SKIP', 'no key to test');
  }

  // 8 ── the frontend release that serves the pay / return pages ────────────
  if (opts.checkFrontend) {
    add('frontend', ...(await frontendVerdict(deps, opts, val, production)));
  }

  // 9 ── (opt-in) the webhook URL, end to end through the ALB/WAF ───────────
  if (opts.probeWebhook) {
    if (active && secret && webhookUrl) {
      checks.push(...(await probeWebhook(deps, opts, secret, webhookUrl)));
    } else {
      add(
        'webhook-probe',
        'FAIL',
        'needs PAYMENT_PROVIDER=tap, the active key and TAP_WEBHOOK_URL',
      );
    }
  }

  return { ok: checks.every((c) => c.status !== 'FAIL'), checks };
}

function firstLine(message: string | undefined): string {
  return String(message ?? 'unknown error')
    .replace(/^❌\s*/, '')
    .split('\n')[0]
    .slice(0, 400);
}

function webhookUrlVerdict(
  raw: string | undefined,
  production: boolean,
): [PreflightStatus, string] {
  if (!raw) {
    return [production ? 'FAIL' : 'WARN', 'TAP_WEBHOOK_URL is not set'];
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ['FAIL', 'TAP_WEBHOOK_URL is not a valid URL'];
  }
  if (url.protocol !== 'https:') {
    return [
      production ? 'FAIL' : 'WARN',
      'TAP_WEBHOOK_URL must be https (Tap accepts plain http silently, then cannot deliver)',
    ];
  }
  if (isPrivateHost(url.hostname)) {
    return [
      'FAIL',
      `TAP_WEBHOOK_URL host "${url.hostname}" is not publicly reachable`,
    ];
  }
  if (!url.pathname.replace(/\/+$/, '').endsWith(WEBHOOK_PATH_SUFFIX)) {
    return [
      'FAIL',
      `TAP_WEBHOOK_URL path must end with ${WEBHOOK_PATH_SUFFIX}`,
    ];
  }
  return ['PASS', `https://${url.hostname}${url.pathname}`];
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  if (
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.localhost')
  )
    return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function tapAuthVerdict(
  deps: PreflightDeps,
  opts: PreflightOptions,
  secret: string,
): Promise<[PreflightStatus, string]> {
  const base = (
    deps.env.TAP_API_BASE?.trim() || 'https://api.tap.company'
  ).replace(/\/+$/, '');
  try {
    const res = await deps.fetch(`${base}/v2/charges/${UNKNOWN_CHARGE_ID}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const code = await errorCodeOf(res);
    if (
      res.status === 401 ||
      res.status === 403 ||
      (code && KEY_REJECTED_CODES.has(code))
    ) {
      return [
        'FAIL',
        `Tap REJECTED the key (http ${res.status}${code ? `, code ${code}` : ''}) — wrong key for TAP_ENV, or the key was revoked`,
      ];
    }
    if (res.status === 400 && code && KEY_ACCEPTED_CODES.has(code)) {
      return [
        'PASS',
        `Tap accepted the key (a read of an unknown charge answered ${code}, as expected)`,
      ];
    }
    if (res.status >= 500 || res.status === 429) {
      return [
        'WARN',
        `Tap answered http ${res.status} — retry; authentication was not exercised`,
      ];
    }
    return [
      'WARN',
      `unexpected answer from Tap (http ${res.status}${code ? `, code ${code}` : ''})`,
    ];
  } catch (err) {
    return [
      'WARN',
      `Tap unreachable from here (${(err as Error)?.name ?? 'error'}) — check egress/NAT`,
    ];
  }
}

async function frontendVerdict(
  deps: PreflightDeps,
  opts: PreflightOptions,
  val: (name: string) => string | undefined,
  production: boolean,
): Promise<[PreflightStatus, string]> {
  const appUrl = (
    val('APP_URL') ?? (val('FRONTEND_ORIGIN') ?? '').split(',')[0].trim()
  ).replace(/\/+$/, '');
  if (!appUrl) return ['WARN', 'neither APP_URL nor FRONTEND_ORIGIN is set'];
  if (production && !appUrl.startsWith('https://')) {
    return [
      'FAIL',
      `APP_URL "${appUrl}" is not https — patients are redirected back to it`,
    ];
  }
  try {
    const res = await deps.fetch(`${appUrl}/pay/return`, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.status === 200) {
      return ['PASS', `${new URL(appUrl).host} serves /pay/return`];
    }
    if (res.status === 404) {
      return [
        'FAIL',
        `${new URL(appUrl).host} answers 404 for /pay/return — the frontend release with the Tap pay pages is NOT deployed`,
      ];
    }
    return [
      'WARN',
      `${new URL(appUrl).host} answered http ${res.status} for /pay/return`,
    ];
  } catch (err) {
    return [
      production ? 'FAIL' : 'WARN',
      `${appUrl} unreachable (${(err as Error)?.name ?? 'error'})`,
    ];
  }
}

async function probeWebhook(
  deps: PreflightDeps,
  opts: PreflightOptions,
  secret: string,
  url: string,
): Promise<PreflightCheck[]> {
  const out: PreflightCheck[] = [];
  const payload = {
    id: 'chg_TS00PREFLIGHT0000000000',
    object: 'charge',
    status: 'CAPTURED',
    amount: 1,
    currency: 'SAR',
    reference: {
      gateway: 'preflight',
      payment: 'preflight',
      transaction: 'preflight-no-such-payment',
    },
    transaction: { created: String(Date.now()) },
  };
  // The ONE copy of the signed-string formula the verifier itself uses.
  const canonical = new TapWebhookVerifier(
    {} as PaymentsConfig,
  ).canonicalString(payload as never);
  if (canonical === null) {
    return [
      {
        id: 'webhook-probe',
        status: 'FAIL',
        detail: 'could not build the signed string (internal error)',
      },
    ];
  }
  const good = createHmac('sha256', secret).update(canonical).digest('hex');
  const bad = createHmac('sha256', `${secret}x`)
    .update(canonical)
    .digest('hex');

  const post = (hashstring: string) =>
    deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', hashstring },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });

  // (a) signed with the deployed key → must be accepted, matching nothing.
  try {
    const res = await post(good);
    const body = await safeJson(res);
    const matched = body?.matched ?? body?.data?.matched;
    if (res.status === 200 && matched === false) {
      out.push({
        id: 'webhook-signed',
        status: 'PASS',
        detail:
          'reachable through the ALB/WAF; signature verified with the deployed key; Tap re-fetch answered (nothing matched, as designed)',
      });
    } else if (res.status === 401) {
      out.push({
        id: 'webhook-signed',
        status: 'FAIL',
        detail:
          'the deployed service REJECTED a delivery signed with the key this task holds — the API and this task are not using the same secret',
      });
    } else if (res.status === 403) {
      out.push({
        id: 'webhook-signed',
        status: 'FAIL',
        detail: 'http 403 — the WAF or ALB is BLOCKING the webhook path',
      });
    } else if (res.status === 404) {
      out.push({
        id: 'webhook-signed',
        status: 'FAIL',
        detail:
          'http 404 — TAP_WEBHOOK_URL does not reach the API route (host, path or ALB rule)',
      });
    } else if (res.status === 503) {
      out.push({
        id: 'webhook-signed',
        status: 'WARN',
        detail: 'http 503 — the API could not reach Tap to re-fetch; retry',
      });
    } else {
      out.push({
        id: 'webhook-signed',
        status: 'FAIL',
        detail: `unexpected http ${res.status}${matched === true ? ' (matched a real payment?!)' : ''}`,
      });
    }
  } catch (err) {
    out.push({
      id: 'webhook-signed',
      status: 'FAIL',
      detail: `${url} unreachable (${(err as Error)?.name ?? 'error'})`,
    });
  }

  // (b) signed with the WRONG key → must be refused (fail-closed).
  try {
    const res = await post(bad);
    out.push(
      res.status === 401
        ? {
            id: 'webhook-unsigned',
            status: 'PASS',
            detail: 'a delivery with a wrong signature is refused (401)',
          }
        : {
            id: 'webhook-unsigned',
            status: 'FAIL',
            detail: `a delivery with a WRONG signature answered http ${res.status} — verification is not enforced`,
          },
    );
  } catch (err) {
    out.push({
      id: 'webhook-unsigned',
      status: 'FAIL',
      detail: `unreachable (${(err as Error)?.name ?? 'error'})`,
    });
  }
  return out;
}

async function errorCodeOf(res: Response): Promise<string | undefined> {
  const body = await safeJson(res);
  const code = body?.errors?.[0]?.code;
  return code === undefined || code === null ? undefined : String(code);
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Plain-text rendering for the CLI. */
export function formatPreflight(report: PreflightReport): string {
  const width = Math.max(...report.checks.map((c) => c.id.length), 8);
  const lines = report.checks.map(
    (c) => `${c.status.padEnd(4)}  ${c.id.padEnd(width)}  ${c.detail}`,
  );
  lines.push('', report.ok ? 'TAP_PREFLIGHT_OK' : 'TAP_PREFLIGHT_FAIL');
  return lines.join('\n');
}
