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
 * Mounting status depends on production's actual Meta callback-URL
 * configuration, which was `UNVERIFIABLE` from either repository as of
 * 2026-08-11 (no committed deployment/IaC configuration exists; the one
 * document expressing *intent*, specs/007-meta-app-review/SUBMISSION-PACK.md,
 * has its callback-registration checklist item unchecked). Per the
 * normative Branch B rule, `modules/notifications/notification-webhook
 * .controller.ts` is therefore NOT deleted and NOT mounted — that decision
 * is a deployment prerequisite (D3, owned by 009) this repository cannot
 * resolve locally, so the file stays exactly as unmounted as it was.
 *
 * Its *comparison algorithm* is a separate, independent question from its
 * *mounting status*, and 010 (specs/010-security-headers-and-regression-
 * suite, T042) was explicitly scoped to fix the former without touching the
 * latter: the shared `constantTimeEqual` primitive (T036) now covers this
 * file too, closing ZT-H01 here regardless of whether the route is ever
 * mounted. There is therefore no longer a KNOWN, deliberately-excluded
 * exception to the comparison invariant at all — every verify-token
 * comparison in the tree, mounted or not, now goes through a constant-time
 * implementation. The second test below asserts the file's *mounting*
 * status specifically (still unmounted, D3 still unresolved) so this file
 * cannot silently stop meaning anything if that file is ever edited.
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

describe('ZT-011 repository invariant — verify-token comparison (Branch B: D3 pending, mounting UNVERIFIABLE)', () => {
  const SRC_ROOT = __dirname; // this file lives at src/webhook-verification-invariant.spec.ts
  const VERIFIER_PATH = 'modules/whatsapp/webhooks/webhook-signature.verifier.ts';
  const KNOWN_UNMOUNTED_FILE = 'modules/notifications/notification-webhook.controller.ts';

  // A verify-token comparison: one operand of a strict (in)equality is the
  // literal identifier `token`, compared directly with `===`/`!==` (as
  // opposed to via a function call like `timingSafeEqual(...)`/
  // `constantTimeEqual(...)`, which is the pattern every legitimate
  // implementation now uses).
  const TOKEN_COMPARISON = /\btoken\s*(===|!==)|(===|!==)\s*token\b/;
  // Narrows the scan to files that are actually about webhook verify-token
  // handling at all (avoids flagging unrelated `token === x` comparisons
  // elsewhere in the codebase, e.g. JWT/refresh-token/CSRF-token code, which
  // have nothing to do with the Meta webhook handshake).
  const MENTIONS_VERIFY_TOKEN = /verify.?token/i;

  it('no source file in the tree contains a raw verify-token comparison — every implementation, mounted or not, is constant-time', () => {
    const offenders = walkTsFiles(SRC_ROOT)
      .map((f) => toRelPosix(SRC_ROOT, f))
      .filter((rel) => rel !== VERIFIER_PATH)
      .filter((rel) => {
        const content = readFileSync(join(SRC_ROOT, rel), 'utf8');
        return MENTIONS_VERIFY_TOKEN.test(content) && TOKEN_COMPARISON.test(content);
      });

    // 010 (T042) closed ZT-H01 in the one previously-known exception too, by
    // routing it through the same shared constantTimeEqual primitive as the
    // mounted verifier — never silently non-empty (which would mean a new
    // divergent, non-constant-time comparison was introduced somewhere).
    expect(offenders).toEqual([]);
  });

  it('the previously-excepted file now uses the shared constant-time primitive, and remains unmounted — this spec is not silently stale', () => {
    const content = readFileSync(join(SRC_ROOT, KNOWN_UNMOUNTED_FILE), 'utf8');
    // The known non-constant-time comparison (010/T042) is gone...
    expect(content).not.toMatch(/token\s*===\s*expected/);
    // ...replaced by the shared primitive, not a bespoke inline fix.
    expect(content).toMatch(/constantTimeEqual\(/);
    // Mounting is a separate, still-unresolved question (D3, owned by 009) —
    // 010 was explicitly scoped to leave this unchanged, and it is: still
    // genuinely unmounted, the structural fact Branch B depends on.
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
