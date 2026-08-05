import { Reflector } from '@nestjs/core';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PaymentLinkController } from './payment-link.controller';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { PERMISSION } from '../../rbac/rbac.constants';
import { AppError, ErrorCode } from '../../common/errors';

/**
 * VER-009 (REQ-PAY-017, P1) — payment-link authorization classification.
 *
 * RESOLVED, WITH A NEW FINDING RAISED (VER-ESC applies — this row does NOT
 * close as "fully implemented"): `GET /payment-links/token/:token`
 * (`getByToken`) — the ONLY code path anywhere in this repository that
 * resolves a payment link by its public token (proven below by a repo-wide
 * scan) — requires:
 *   1. `JwtAuthGuard` (global, applies to every route unless `@Public()` is
 *      present — proven absent below, both class- and method-level) — a
 *      valid staff/platform Bearer token.
 *   2. `PermissionsGuard` + `@RequirePermissions(PAYMENTS_READ)` — a STAFF
 *      permission a `Patient` (VER-007: no roles/permissions at all, ever)
 *      could never hold, proven below by directly exercising the real guard.
 *   3. `PaymentLinkService.getByToken(tenantId, token)` additionally scopes
 *      the lookup to the CALLER'S OWN tenant (`ctx.requireTenantId()`) — an
 *      anonymous payer has no tenant context to supply even if somehow
 *      authenticated another way.
 *
 * This is airtight for its ACTUAL, evidenced purpose — a clinic tracking its
 * own previously-issued links — but makes it STRUCTURALLY IMPOSSIBLE for the
 * external, unauthenticated recipient of a shared payment link (the entire
 * point of a "payment link") to ever resolve or pay it. Per this wave's
 * governing instruction: "if an unauthenticated payer genuinely cannot
 * resolve a payment link, that is a BROKEN PAYMENT JOURNEY, not a
 * documentation gap" — proven true here, not assumed. A real public
 * checkout endpoint (and frontend page) does not exist and is NOT built by
 * this session (out of Wave 4's verification scope — a P2 wave — and a P1
 * product/security surface of its own, requiring its own design: anonymous-
 * endpoint rate limiting, abuse posture, and a public UI). Raised as a new
 * finding for a dedicated follow-up (see the session's completion report /
 * spawned task).
 */
describe('PaymentLinkController.getByToken — authorization classification (VER-009)', () => {
  const reflector = new Reflector();

  it('carries NO @Public() marker anywhere (class or method) — JwtAuthGuard treats it as authenticated-only, same as every other route on this controller', () => {
    const classLevel = reflector.get(IS_PUBLIC_KEY, PaymentLinkController);
    const methodLevel = reflector.get(IS_PUBLIC_KEY, PaymentLinkController.prototype.getByToken);
    expect(classLevel).toBeFalsy();
    expect(methodLevel).toBeFalsy();
  });

  it('requires the STAFF permission payments.read — a permission a Patient (VER-007) can never hold', () => {
    const required = reflector.get(PERMISSIONS_KEY, PaymentLinkController.prototype.getByToken);
    expect(required).toEqual([PERMISSION.PAYMENTS_READ]);
  });

  it('PROOF (real PermissionsGuard, no HTTP mocking): a caller with NO staff permissions — the closest an external payer with a token could ever get, even if somehow authenticated — is refused with PERMISSION_DENIED', () => {
    const guard = new PermissionsGuard(new Reflector());
    const ctx = {
      getHandler: () => PaymentLinkController.prototype.getByToken,
      getClass: () => PaymentLinkController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { roles: [], permissions: [] } }),
      }),
    } as any;

    let thrown: AppError | undefined;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      thrown = err as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown!.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('a genuinely unauthenticated caller (no user on the request at all) is refused by the SAME guard for the SAME reason', () => {
    const guard = new PermissionsGuard(new Reflector());
    const ctx = {
      getHandler: () => PaymentLinkController.prototype.getByToken,
      getClass: () => PaymentLinkController,
      switchToHttp: () => ({ getRequest: () => ({ user: undefined }) }),
    } as any;

    let thrown: AppError | undefined;
    try {
      guard.canActivate(ctx);
    } catch (err) {
      thrown = err as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown!.code).toBe(ErrorCode.PERMISSION_DENIED);
  });

  it('REPO-WIDE PROOF: PaymentLink (the entity) is imported by exactly ONE service anywhere in src/ — there is no alternate, public resolution path this test could have missed', () => {
    const srcRoot = path.join(__dirname, '..', '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.spec.ts') &&
          !entry.name.endsWith('.module.ts') // DI registration only (TypeOrmModule.forFeature) — never a resolution path
        ) {
          const contents = fs.readFileSync(full, 'utf8');
          if (/from ['"][^'"]*entities\/Payments\/PaymentLink['"]/.test(contents)) {
            hits.push(path.relative(srcRoot, full).split(path.sep).join('/'));
          }
        }
      }
    };
    walk(srcRoot);
    expect(hits.sort()).toEqual(['modules/payments/payment-link.service.ts']);
  });
});
