import { Reflector } from '@nestjs/core';

import { GuestChatController } from './guest-chat.controller';
import { IS_SKIP_CSRF_KEY } from '../auth/decorators/skip-csrf.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

/**
 * Pins `POST /public/guest/session`'s CSRF exemption at the decorator level.
 *
 * Reproduces the real bug: `AiOrchestratorController`/`AiRealtimeGateway` are
 * fine, but a visitor whose PREVIOUS session had gone stale — an expired or
 * revoked refresh token failed silently in `axiosInstance`'s response
 * interceptor, which clears the JS-readable `csrf_token` cookie but (being
 * HttpOnly) cannot touch the still-present `access_token` cookie — could
 * never even START a guest chat again. `CsrfGuard` saw the leftover auth
 * cookie (by name only, never verifying it) and demanded a CSRF header the
 * client no longer had, so every attempt 403'd with "CSRF token missing or
 * invalid" until that cookie's own maxAge finally expired.
 *
 * `session()` never reads an incoming AUTH cookie to authorize anything. It
 * does read an incoming `guest_token` to decide whether to REUSE that
 * identity (`GuestSessionService.resolveSession()`), but that grants no new
 * authority — a forged/replayed call at worst reuses the caller's own
 * existing identity, an idempotent no-op — so it still belongs to the same
 * class of session-genesis endpoint as `login`/`register-owner`/
 * `forgot-password`, all of which already carry `@SkipCsrf()`.
 *
 * `convert()` is the deliberate contrast: it DOES read the incoming
 * `guest_token` cookie to authorize which conversation it may act on, so it
 * must keep CSRF enforced and must NOT gain this decorator.
 */
describe('GuestChatController — CSRF exemption is scoped to the genesis endpoint only', () => {
  const reflector = new Reflector();

  it('session() is @Public() and @SkipCsrf() — a stale auth cookie must never block minting a guest session', () => {
    expect(
      reflector.get(IS_PUBLIC_KEY, GuestChatController.prototype.session),
    ).toBe(true);
    expect(
      reflector.get(IS_SKIP_CSRF_KEY, GuestChatController.prototype.session),
    ).toBe(true);
  });

  it('convert() keeps CSRF enforced — it reads the guest_token cookie to authorize the conversion', () => {
    expect(
      reflector.get(IS_SKIP_CSRF_KEY, GuestChatController.prototype.convert),
    ).not.toBe(true);
  });
});
