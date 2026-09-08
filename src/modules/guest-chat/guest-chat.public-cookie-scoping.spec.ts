import { GuestChatController } from './guest-chat.controller';

/**
 * Contract C10 — `PUBLIC_COOKIE_SAMESITE`/`PUBLIC_COOKIE_DOMAIN` scope the
 * `guest_token` cookie independently from the global `COOKIE_SAMESITE`/
 * `COOKIE_DOMAIN` (which still govern the staff session cookies via
 * `CookieService`, untouched by this change).
 */

function buildController(env: Record<string, string | undefined>) {
  const config = { get: jest.fn((key: string, fallback?: unknown) => env[key] ?? fallback) };
  const guest = {
    resolveSession: jest.fn().mockResolvedValue({
      token: 'new-token',
      guestId: 'guest-1',
      maxAgeMs: 60_000,
      isNew: true,
    }),
  };
  const tenantContext = {};
  const controller = new GuestChatController(guest as never, config as never, tenantContext as never);
  return { controller };
}

function fakeReqRes() {
  const cookie = jest.fn();
  const req = { cookies: {} } as never;
  const res = { cookie } as never;
  return { req, res, cookie };
}

describe('GuestChatController — guest_token cookie scoping (C10)', () => {
  it('uses PUBLIC_COOKIE_SAMESITE/PUBLIC_COOKIE_DOMAIN when set, independent of the global vars', async () => {
    const { controller } = buildController({
      COOKIE_SAMESITE: 'lax',
      COOKIE_DOMAIN: 'app.ziyaratech.com',
      PUBLIC_COOKIE_SAMESITE: 'none',
      PUBLIC_COOKIE_DOMAIN: '.ziyaratech.com',
      NODE_ENV: 'production',
    });
    const { req, res, cookie } = fakeReqRes();

    await controller.session(req, res);

    expect(cookie).toHaveBeenCalledWith(
      'guest_token',
      'new-token',
      expect.objectContaining({ sameSite: 'none', domain: '.ziyaratech.com', secure: true, httpOnly: true }),
    );
  });

  it('falls back to the global COOKIE_SAMESITE/COOKIE_DOMAIN when the PUBLIC_ vars are unset', async () => {
    const { controller } = buildController({
      COOKIE_SAMESITE: 'strict',
      COOKIE_DOMAIN: 'app.ziyaratech.com',
    });
    const { req, res, cookie } = fakeReqRes();

    await controller.session(req, res);

    expect(cookie).toHaveBeenCalledWith(
      'guest_token',
      'new-token',
      expect.objectContaining({ sameSite: 'strict', domain: 'app.ziyaratech.com' }),
    );
  });

  it('defaults to lax/no-domain when neither is set (current deployment behaviour unchanged)', async () => {
    const { controller } = buildController({});
    const { req, res, cookie } = fakeReqRes();

    await controller.session(req, res);

    expect(cookie).toHaveBeenCalledWith(
      'guest_token',
      'new-token',
      expect.objectContaining({ sameSite: 'lax', domain: undefined }),
    );
  });
});
