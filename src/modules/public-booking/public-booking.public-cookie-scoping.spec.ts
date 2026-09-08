import { PublicBookingController } from './public-booking.controller';

/**
 * Contract C10 — `booking_session_id` cookie scoping. Same rule as
 * `guest_token` (see guest-chat's own C10 test): PUBLIC_COOKIE_SAMESITE/DOMAIN
 * scope this cookie independently of the global staff-cookie vars.
 */

function buildController(env: Record<string, string | undefined>) {
  const config = { get: jest.fn((key: string, fallback?: unknown) => env[key] ?? fallback) };
  const guestSessions = {
    resolveSession: jest.fn().mockResolvedValue({
      token: 'guest-tok',
      guestId: 'guest-1',
      tenantId: 'tenant-1',
      maxAgeMs: 60_000,
      isNew: false, // guest_token already valid — isolates this test to the booking cookie only
    }),
  };
  const bookingContext = {
    ensureConversation: jest.fn().mockResolvedValue('new-conversation-id'),
  };
  const flow = {
    getSelection: jest.fn().mockResolvedValue({ stage: 'clinic' }),
  };
  const controller = new PublicBookingController(
    guestSessions as never,
    bookingContext as never,
    flow as never,
    config as never,
  );
  return { controller };
}

function fakeReqRes() {
  const cookie = jest.fn();
  const req = { cookies: {} } as never;
  const res = { cookie } as never;
  return { req, res, cookie };
}

describe('PublicBookingController — booking_session_id cookie scoping (C10)', () => {
  it('uses PUBLIC_COOKIE_SAMESITE/PUBLIC_COOKIE_DOMAIN when set', async () => {
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
      'booking_session_id',
      'new-conversation-id',
      expect.objectContaining({ sameSite: 'none', domain: '.ziyaratech.com', secure: true, httpOnly: true }),
    );
  });

  it('falls back to the global COOKIE_SAMESITE/COOKIE_DOMAIN when unset', async () => {
    const { controller } = buildController({
      COOKIE_SAMESITE: 'strict',
      COOKIE_DOMAIN: 'app.ziyaratech.com',
    });
    const { req, res, cookie } = fakeReqRes();

    await controller.session(req, res);

    expect(cookie).toHaveBeenCalledWith(
      'booking_session_id',
      'new-conversation-id',
      expect.objectContaining({ sameSite: 'strict', domain: 'app.ziyaratech.com' }),
    );
  });

  it('defaults to lax/no-domain when neither is set', async () => {
    const { controller } = buildController({});
    const { req, res, cookie } = fakeReqRes();

    await controller.session(req, res);

    expect(cookie).toHaveBeenCalledWith(
      'booking_session_id',
      'new-conversation-id',
      expect.objectContaining({ sameSite: 'lax', domain: undefined }),
    );
  });
});
