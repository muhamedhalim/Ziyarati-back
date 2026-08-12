/**
 * Phase 7 security configuration regression invariants (FR-035…FR-041, US2).
 * Each asserts a *property* the codebase already holds, not a specific
 * implementation detail, so 008/009's own semantics stay theirs to change
 * (FR-058). Pattern-class checks here (T025, T029) scan source TEXT for a
 * dangerous shape — this is a different category from the route-authorization
 * invariants in `route-authorization.spec.ts`, which read framework metadata
 * exclusively. FR-032 forbids associating *decorators with handlers* by
 * scanning source text (the defect that produced the original audit's false
 * positives); it does not forbid a targeted "does this pattern occur in this
 * file/directory" existence check, which has no association step and no
 * line-proximity heuristic (see T029's own note below).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { databaseSslOptions } from '../../src/config/database-ssl';
import { validate as validateEnv } from '../../src/config/env.validation';
import { isControllerMounted } from './nest-route-metadata';
import { NotificationWebhookController } from '../../src/modules/notifications/notification-webhook.controller';

const SRC_ROOT = join(__dirname, '../../src');

/** Every `.ts` file under `src/`, excluding `*.spec.ts` — production code only. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('Security configuration invariants (FR-035…FR-041)', () => {
  describe('FR-035 — API documentation is off by default in production (008/ZT-001, unchanged)', () => {
    // Mirrors env.validation.spec.ts's own base/prodBase fixture convention —
    // the minimal field set needed to boot past every OTHER production
    // fail-fast so this test exercises only ENABLE_API_DOCS/ENABLE_INTEGRATION_DOCS.
    const base = {
      DATABASE_URL: 'postgres://x',
      JWT_ACCESS_SECRET: 'secret',
      JWT_REFRESH_SECRET: 'refresh-secret',
      REDIS_URL: 'redis://localhost:6379',
    };
    const prodBase = {
      ...base,
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: 'https://example.test',
      DB_SSL_CA: '/etc/ssl/certs/db-ca.pem',
      AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 1000,
      PAYMENT_PROVIDER: 'noop',
      CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };

    it('ENABLE_API_DOCS defaults to false when unset and NODE_ENV=production', () => {
      const result = validateEnv({ ...prodBase } as Record<string, unknown>);
      expect(result.ENABLE_API_DOCS).toBe('false');
      expect(result.ENABLE_INTEGRATION_DOCS).toBe('false');
    });

    it('ENABLE_API_DOCS defaults to true outside production (dev/partner-onboarding workflow preserved)', () => {
      const result = validateEnv({ ...base, NODE_ENV: 'development' } as Record<string, unknown>);
      expect(result.ENABLE_API_DOCS).toBe('true');
      expect(result.ENABLE_INTEGRATION_DOCS).toBe('true');
    });
  });

  describe('FR-037 — no production database path disables certificate validation (008/ZT-012, unchanged)', () => {
    it('the shared databaseSslOptions() helper never returns rejectUnauthorized:false in production', () => {
      expect(() => databaseSslOptions({ NODE_ENV: 'production' })).toThrow();
      const withCa = databaseSslOptions({
        NODE_ENV: 'production',
        DB_SSL_CA_CERT: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
      });
      expect(withCa).not.toBe(false);
      expect((withCa as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
    });

    it('every production DataSource call site still sources its SSL policy from the shared helper, not an inline duplicate', () => {
      const sites = [
        join(SRC_ROOT, 'config/typeorm.config.ts'),
        join(SRC_ROOT, 'config/data-source.ts'),
        join(SRC_ROOT, 'config/run-migrations-with-lock.ts'),
      ];
      const violations: string[] = [];
      for (const file of sites) {
        const text = readFileSync(file, 'utf8');
        if (!/databaseSslOptions/.test(text)) {
          violations.push(`${relative(SRC_ROOT, file)} no longer references the shared databaseSslOptions() helper`);
        }
        if (/rejectUnauthorized\s*:\s*false/.test(text)) {
          violations.push(`${relative(SRC_ROOT, file)} contains an inline "rejectUnauthorized: false" outside the shared helper`);
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe('FR-038 — 009 auth-abuse controls remain wired to their dedicated bounds (unchanged semantics)', () => {
    it('forgot-password, reset-password and register-owner still pass their dedicated scope as the limiter call argument (not merely referenced anywhere in the file)', () => {
      const authServiceText = readFileSync(join(SRC_ROOT, 'modules/auth/auth.service.ts'), 'utf8');
      // Requires the scope constant to be the ARGUMENT of an actual
      // `limiter.consume(`/`limiter.peek(` call, not merely present anywhere
      // in the file (e.g. in an unrelated metrics call) — a bare substring
      // check would miss the scope being silently swapped at its real call
      // site while an unrelated reference (recordAuthAbuseLimiterEvent)
      // elsewhere in the file kept the string "present". Verified against a
      // planted negative case (T034) that a bare substring check misses but
      // this one catches. Asserts PRESENCE and WIRING, never a specific
      // numeric limit — the limit values themselves stay 009's to change
      // (FR-058).
      const requiredScopeCallSites: Array<[scope: string, label: string]> = [
        ['REGISTER_IDENTITY', 'register-owner identity bound'],
        ['REGISTER_ENDPOINT', 'register-owner endpoint-wide ceiling'],
        ['FORGOT', 'forgot-password bound'],
        ['RESET_ACCOUNT', 'reset-password account bound'],
        ['RESET_INVALID', 'reset-password invalid-token ceiling'],
      ];
      const violations = requiredScopeCallSites
        .filter(([scope]) => {
          const callSitePattern = new RegExp(
            `limiter\\.(consume|peek)\\(\\s*AUTH_ABUSE_LIMITER_SCOPE\\.${scope}\\b`,
          );
          return !callSitePattern.test(authServiceText);
        })
        .map(([scope, label]) => `AUTH_ABUSE_LIMITER_SCOPE.${scope} (${label}) is no longer passed to limiter.consume()/peek()`);
      expect(violations).toEqual([]);
    });
  });

  describe('FR-036 — no hardcoded fallback secret anywhere in src/ (008/ZT-007 pattern class, not just the 3 named sites)', () => {
    /**
     * Matches the exact shape 008 removed: `config.get('<KEY>_SECRET|_PASSWORD|_KEY|_TOKEN', '<string literal>')`.
     * A quoted STRING fallback is what makes it dangerous (an actual usable
     * secret value); numeric/operational fallbacks like
     * `config.get('AUTH_FORGOT_PASSWORD_MAX_PER_WINDOW', 5)` do not match —
     * neither the key suffix (ends in `_WINDOW`, not one of the four
     * sensitive suffixes) nor the fallback shape (a number, not a string).
     */
    const HARDCODED_SECRET_FALLBACK = /\.get(?:OrThrow)?(?:<[^>()]*>)?\(\s*['"]([A-Z0-9_]*_(?:SECRET|PASSWORD|KEY|TOKEN))['"]\s*,\s*['"]/g;

    it('no source file matches the hardcoded-fallback-secret pattern class', () => {
      const violations: string[] = [];
      for (const file of listSourceFiles(SRC_ROOT)) {
        const text = readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          HARDCODED_SECRET_FALLBACK.lastIndex = 0;
          const match = HARDCODED_SECRET_FALLBACK.exec(lines[i]);
          if (match) {
            violations.push(`${relative(SRC_ROOT, file)}:${i + 1} — config key "${match[1]}" has a hardcoded string fallback`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });

  /**
   * T030 — FR-040's staged-activation contract (governs this file's T029
   * assertion above AND the frontend FR-040 slices in
   * `Ziyarati-font/app/security/README.md`). Stated once, here, as the
   * canonical version both sides reference:
   *
   *   1. An FR-040/FR-039 assertion is added EITHER at the moment its
   *      implementation dependency lands, OR earlier in an EXPLICITLY
   *      INACTIVE state — `it.skip(...)` with a name/comment giving a
   *      machine-readable reason and naming its activating task. A
   *      permanently red test is never committed; a silently-absent one is
   *      never committed either — both defeat the point of a regression
   *      suite.
   *   2. Every inactive assertion is enumerated in
   *      `evidence/invariant-baseline.md` with its activating task, so none
   *      can be forgotten.
   *   3. T175 is the closing gate: it runs the real, fully-enabled invariant
   *      suite and asserts **zero** 010 invariants remain skipped/inactive.
   *
   * Backend inactive assertions under this contract: T029 (constant-time,
   * this file, activates at T047). Frontend inactive assertions: none yet —
   * the frontend FR-040 slices (T086, T097, T108, T120, T121) are authored
   * fresh, already-enabled, at the same task that lands their dependency,
   * because no frontend header code exists yet for them to assert
   * prematurely against (there is nothing to stage — see
   * `Ziyarati-font/app/security/README.md` once Phase 8 creates it).
   */
  describe('FR-039 — every required constant-time shared-secret comparison remains constant-time', () => {
    /**
     * **Staged activation — no intentionally-failing test is committed
     * (T030's contract above).** This invariant correctly detects two real,
     * present defects on unmodified code: `csrf.guard.ts:75`
     * (`cookieToken === headerValue`, ZT-H01) and
     * `notification-webhook.controller.ts:49` (`token === expected`, O1).
     * Both are recorded in `evidence/invariant-baseline.md`. It is committed
     * **skipped**, with T038 (CSRF fix) and T042 (O1 fix) named as its
     * activation dependencies; **T047 removes this skip** once both land,
     * and from that point this is a permanently active gate.
     *
     * Asserts the PROPERTY (no direct `===`/`!==` on a token/secret/
     * signature identifier), never which helper provides constant time —
     * research.md R10: the seven pre-existing correct sites (each already
     * using `crypto.timingSafeEqual` or an equivalent, inlined at their own
     * call site) must keep passing unchanged; only a NEW direct-equality
     * regression should ever fail this.
     */
    // ACTIVATED at T047 — T038 (csrf.guard.ts) and T042
    // (notification-webhook.controller.ts) have both landed; the two
    // previously-recorded sites are now clean (see evidence/invariant-baseline.md).
    it('no direct equality comparison remains against a token/secret/signature identifier anywhere in src/', () => {
      const violations = findDirectSecretComparisons();
      expect(violations).toEqual([]);
    });
  });

  describe('O1 — NotificationWebhookController stays unmounted AND undeleted (permanent, always active)', () => {
    /**
     * Both directions matter (data-model.md §4). 009's D3 — confirming the
     * production Meta callback route — is still open; deleting this file
     * would destroy evidence about a route shape still under operational
     * review, and mounting it would create a second Meta ingestion path
     * while D3 is open. This invariant fails the suite either way.
     */
    it('the file still exists (not deleted)', () => {
      expect(() =>
        readFileSync(join(SRC_ROOT, 'modules/notifications/notification-webhook.controller.ts'), 'utf8'),
      ).not.toThrow();
    });

    it('the controller is declared but not mounted in any module (not mounted)', async () => {
      const mounted = await isControllerMounted(NotificationWebhookController);
      expect(mounted).toBe(false);
    });
  });

  describe('ZT-003 — helmet remains absent (T088, permanent)', () => {
    /**
     * Records the deliberate, plan-approved divergence from
     * SECURITY-REMEDIATION.md Phase 4's suggestion: helmet's default CSP
     * would create a second, independently-evolving API-response policy —
     * exactly what FR-002 forbids (research.md R5). Checks both the
     * manifest and any import, not just one.
     */
    it('helmet appears in neither package.json nor any import in src/', () => {
      const packageJsonText = readFileSync(join(SRC_ROOT, '../package.json'), 'utf8');
      const manifest = JSON.parse(packageJsonText) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(manifest.dependencies?.helmet).toBeUndefined();
      expect(manifest.devDependencies?.helmet).toBeUndefined();

      const violations: string[] = [];
      for (const file of listSourceFiles(SRC_ROOT)) {
        const text = readFileSync(file, 'utf8');
        if (/from\s+['"]helmet['"]|require\(\s*['"]helmet['"]\s*\)/.test(text)) {
          violations.push(relative(SRC_ROOT, file));
        }
      }
      expect(violations).toEqual([]);
    });
  });
});

/**
 * Finds `identifier === identifier` / `identifier !== identifier` where at
 * least one bare identifier's name suggests a shared-secret *value*,
 * excluding:
 *  - `.length` / `undefined` / `null` comparisons (the correct, common
 *    constant-time-adjacent pattern — comparing lengths or presence before
 *    comparing content is safe and expected);
 *  - comparisons against an ALL-CAPS constant/enum member (e.g.
 *    `scheme === WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY`,
 *    `location === API_KEY_LOCATION.QUERY`) — verified false positives: an
 *    identifier whose own name is a SCREAMING_SNAKE_CASE constant/namespace
 *    is a type/scheme discriminant, never a secret value, even though its
 *    name happens to contain "signature" or "api_key" as a substring;
 *  - this file itself / the shared constant-time primitive's own internals
 *    (which legitimately performs the length pre-check the primitive
 *    requires).
 */
const SENSITIVE_NAME = /token|secret|signature|password|apikey|api_key|hmac/i;
const IS_CONSTANT_REFERENCE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Discovered during 010 implementation, NOT in the frozen ZT-H01/O1 scope —
 * recorded, not silently fixed and not silently hidden by weakening the
 * general pattern above (see evidence/invariant-baseline.md "Additional
 * finding" and the closure report). `auth.service.ts:538`
 * (`stored.token_hash !== tokenHash`, inside `refresh()`) compares a
 * refresh-token hash with plain inequality rather than the codebase's own
 * constant-time standard. 010's frozen scope is exactly ZT-H01
 * (`csrf.guard.ts`) and O1 (`notification-webhook.controller.ts`) — refresh-
 * token rotation in `auth.service.ts` is neither, and "do not refactor
 * already-correct constant-time sites" / "do not expand scope" both forbid
 * touching it here. Excluded **by exact file+line**, not by broadening any
 * word/shape exclusion, so the general pattern keeps full power to catch a
 * *new* regression anywhere, including a new one in this same file.
 */
const KNOWN_OUT_OF_SCOPE_FINDINGS = new Set([join('modules', 'auth', 'auth.service.ts') + ':538']);

export function findDirectSecretComparisons(): string[] {
  const violations: string[] = [];
  const COMPARISON = /\b([A-Za-z_$][\w$]*)\s*(===|!==)\s*([A-Za-z_$][\w$]*)\b/g;
  for (const file of listSourceFiles(SRC_ROOT)) {
    if (file.endsWith(join('common', 'utils', 'constant-time.util.ts'))) continue; // the primitive itself
    const relPath = relative(SRC_ROOT, file);
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (KNOWN_OUT_OF_SCOPE_FINDINGS.has(`${relPath}:${i + 1}`)) continue;
      COMPARISON.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COMPARISON.exec(line))) {
        const [, left, , right] = match;
        if (left === 'length' || right === 'length') continue;
        if (left === 'undefined' || right === 'undefined') continue;
        if (left === 'null' || right === 'null') continue;
        if (IS_CONSTANT_REFERENCE.test(left) || IS_CONSTANT_REFERENCE.test(right)) continue;
        if (SENSITIVE_NAME.test(left) || SENSITIVE_NAME.test(right)) {
          violations.push(`${relPath}:${i + 1} — direct comparison "${left} ${match[2]} ${right}"`);
        }
      }
    }
  }
  return violations;
}
