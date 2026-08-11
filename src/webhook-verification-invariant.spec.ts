import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

/**
 * ZT-011 repository invariant — `WebhookSignatureVerifier.resolveChallenge`
 * (`modules/whatsapp/webhooks/webhook-signature.verifier.ts`) MUST be the
 * only verify-token comparison reachable at runtime in this codebase
 * (FR-042). Complements `all-controllers.spec.ts`'s "every controller loads"
 * smoke coverage with the opposite direction: no SECOND, divergent
 * comparison exists outside the one shared, constant-time, unit-tested
 * implementation.
 *
 * Scope depends on T034's outcome (tasks.md Phase 3). T034 returned
 * `UNVERIFIABLE` on 2026-08-11 — production's actual Meta callback-URL
 * configuration cannot be determined from either repository (no committed
 * deployment/IaC configuration exists at all; the one document expressing
 * *intent*, specs/007-meta-app-review/SUBMISSION-PACK.md, has its callback-
 * registration checklist item unchecked). Per the normative Branch B rule,
 * `modules/notifications/notification-webhook.controller.ts` is therefore
 * NOT deleted, NOT mounted, NOT repaired — it is scoped OUT of this
 * assertion as a KNOWN, deliberately-excluded exception, tracked by ZT-011
 * and blocked by T038 pending an explicit decision on production callback
 * configuration (deployment prerequisite D3). The second test below asserts
 * the exception's own known defect is still present and unchanged, so this
 * file cannot silently stop meaning anything if that file is ever edited.
 */

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Forward-slash, forward-relative-to-src path, for a stable cross-platform comparison. */
function toRelPosix(srcRoot: string, absPath: string): string {
  return relative(srcRoot, absPath).split('\\').join('/');
}

describe('ZT-011 repository invariant — verify-token comparison (Branch B: T034 = UNVERIFIABLE)', () => {
  const SRC_ROOT = __dirname; // this file lives at src/webhook-verification-invariant.spec.ts
  const VERIFIER_PATH = 'modules/whatsapp/webhooks/webhook-signature.verifier.ts';
  const KNOWN_UNMOUNTED_EXCEPTION = 'modules/notifications/notification-webhook.controller.ts';

  // A verify-token comparison: one operand of a strict (in)equality is the
  // literal identifier `token`, compared directly with `===`/`!==` (as
  // opposed to via a function call like `timingSafeEqual(...)`, which is the
  // pattern the one legitimate implementation uses).
  const TOKEN_COMPARISON = /\btoken\s*(===|!==)|(===|!==)\s*token\b/;
  // Narrows the scan to files that are actually about webhook verify-token
  // handling at all (avoids flagging unrelated `token === x` comparisons
  // elsewhere in the codebase, e.g. JWT/refresh-token/CSRF-token code, which
  // have nothing to do with the Meta webhook handshake).
  const MENTIONS_VERIFY_TOKEN = /verify.?token/i;

  it('no source file outside the shared verifier — and the one documented, unmounted exception — contains a verify-token comparison', () => {
    const offenders = walkTsFiles(SRC_ROOT)
      .map((f) => toRelPosix(SRC_ROOT, f))
      .filter((rel) => rel !== VERIFIER_PATH)
      .filter((rel) => {
        const content = readFileSync(join(SRC_ROOT, rel), 'utf8');
        return MENTIONS_VERIFY_TOKEN.test(content) && TOKEN_COMPARISON.test(content);
      });

    // Exactly the one known, tracked exception — never silently zero (which
    // would mean this test stopped scanning anything meaningful) and never
    // anything ELSE (which would mean a new divergent comparison was added).
    expect(offenders).toEqual([KNOWN_UNMOUNTED_EXCEPTION]);
  });

  it('the excluded exception still contains its known, unremediated non-constant-time comparison — this spec is not silently stale', () => {
    const content = readFileSync(join(SRC_ROOT, KNOWN_UNMOUNTED_EXCEPTION), 'utf8');
    expect(content).toMatch(/token\s*===\s*expected/);
    // And it is still genuinely unmounted — the structural fact Branch B depends on.
    const moduleContent = readFileSync(
      join(SRC_ROOT, 'modules/notifications/notifications.module.ts'),
      'utf8',
    );
    expect(moduleContent).not.toContain('NotificationWebhookController');
  });

  it('the mounted live handshake route uses the shared verifier, not an inline comparison', () => {
    const controller = readFileSync(
      join(SRC_ROOT, 'modules/whatsapp/whatsapp-webhook.controller.ts'),
      'utf8',
    );
    expect(controller).not.toMatch(TOKEN_COMPARISON);
    const service = readFileSync(join(SRC_ROOT, 'modules/whatsapp/whatsapp-webhook.service.ts'), 'utf8');
    expect(service).toMatch(/this\.verifier\.resolveChallenge/);
    expect(service).not.toMatch(TOKEN_COMPARISON);
  });
});
