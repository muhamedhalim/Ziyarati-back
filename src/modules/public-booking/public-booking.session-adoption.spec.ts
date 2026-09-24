import { PublicBookingController } from './public-booking.controller';
import { PublicBookingContextService } from './public-booking-context.service';

/**
 * Marketplace Phase 6 — `POST /public/booking/session` may adopt the chat widget's own
 * conversation so a "Book" click and the assistant share ONE conversation (the AI's pinned
 * booking block reads the chat conversation, so selections written to a different one never
 * reached it). Adoption is additive and never widens trust: the id is honoured only when the
 * same `assertAccess` gate every other path uses says this guest owns it.
 */

const TENANT = 'tenant-1';
const GUEST = 'guest-1';

function buildController(
  opts: { cookieConversation?: string; owned?: string[] } = {},
) {
  const owned = new Set(opts.owned ?? []);
  const config = { get: jest.fn((_k: string, fallback?: unknown) => fallback) };
  const guestSessions = {
    resolveSession: jest.fn().mockResolvedValue({
      token: 'tok',
      guestId: GUEST,
      tenantId: TENANT,
      maxAgeMs: 60_000,
      isNew: false,
    }),
  };
  // Real ownership semantics: ensureConversation / adoptOwnedConversation both go through
  // this stub of `assertAccess`; anything not in `owned` is refused.
  const access = {
    assertAccess: jest.fn(async (_t: string, id: string) => {
      if (!owned.has(id)) throw new Error('forbidden');
    }),
  };
  const conversations = {
    create: jest.fn().mockReturnValue({ id: 'conv-minted' }),
    save: jest.fn().mockResolvedValue({ id: 'conv-minted' }),
  };
  const sessions = {
    patch: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
  };
  const bookingContext = new PublicBookingContextService(
    { query: jest.fn() } as never,
    access as never,
    sessions as never,
    conversations as never,
  );
  const flow = {
    getSelection: jest.fn().mockResolvedValue({ stage: 'clinic' }),
  };
  const controller = new PublicBookingController(
    guestSessions as never,
    bookingContext as never,
    flow as never,
    config as never,
  );
  const cookie = jest.fn();
  const req = {
    cookies: opts.cookieConversation
      ? { booking_session_id: opts.cookieConversation }
      : {},
  } as never;
  const res = { cookie } as never;
  return { controller, req, res, cookie, flow, conversations, access };
}

const bookingCookieWrites = (cookie: jest.Mock) =>
  cookie.mock.calls.filter(([name]) => name === 'booking_session_id');

describe('POST /public/booking/session — conversation adoption', () => {
  it('adopts the chat conversation when this guest owns it, rewrites the cookie, and returns it', async () => {
    const { controller, req, res, cookie, flow, conversations } =
      buildController({
        cookieConversation: 'conv-cookie',
        owned: ['conv-cookie', 'conv-chat'],
      });

    const result = await controller.session(req, res, {
      conversationId: 'conv-chat',
    });

    expect(result.conversationId).toBe('conv-chat');
    expect(flow.getSelection).toHaveBeenCalledWith(
      TENANT,
      'conv-chat',
      expect.anything(),
    );
    expect(bookingCookieWrites(cookie)).toEqual([
      ['booking_session_id', 'conv-chat', expect.anything()],
    ]);
    expect(conversations.create).not.toHaveBeenCalled();
  });

  it("refuses another guest's conversation: keeps the cookie's own, never echoes the foreign id", async () => {
    const { controller, req, res, cookie, flow } = buildController({
      cookieConversation: 'conv-cookie',
      owned: ['conv-cookie'],
    });

    const result = await controller.session(req, res, {
      conversationId: 'conv-someone-else',
    });

    expect(result.conversationId).toBe('conv-cookie');
    expect(flow.getSelection).toHaveBeenCalledWith(
      TENANT,
      'conv-cookie',
      expect.anything(),
    );
    expect(JSON.stringify(result)).not.toContain('someone-else');
    expect(bookingCookieWrites(cookie)).toEqual([]); // nothing changed, nothing rewritten
  });

  it('a foreign id with no cookie mints a fresh conversation rather than adopting it', async () => {
    const { controller, req, res, cookie } = buildController({ owned: [] });

    const result = await controller.session(req, res, {
      conversationId: 'conv-someone-else',
    });

    expect(result.conversationId).toBe('conv-minted');
    expect(bookingCookieWrites(cookie)).toEqual([
      ['booking_session_id', 'conv-minted', expect.anything()],
    ]);
  });

  it('fresh:true ignores both the cookie and any conversationId and starts a new conversation', async () => {
    const { controller, req, res, cookie, conversations } = buildController({
      cookieConversation: 'conv-cookie',
      owned: ['conv-cookie', 'conv-chat'],
    });

    const result = await controller.session(req, res, {
      conversationId: 'conv-chat',
      fresh: true,
    });

    expect(result.conversationId).toBe('conv-minted');
    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(bookingCookieWrites(cookie)).toEqual([
      ['booking_session_id', 'conv-minted', expect.anything()],
    ]);
  });

  it('a body-less call behaves exactly as before and now also reports conversationId and guestId', async () => {
    const { controller, req, res, cookie } = buildController({
      cookieConversation: 'conv-cookie',
      owned: ['conv-cookie'],
    });

    const result = await controller.session(req, res);

    expect(result).toEqual({
      selection: { stage: 'clinic' },
      conversationId: 'conv-cookie',
      guestId: GUEST,
    });
    expect(bookingCookieWrites(cookie)).toEqual([]);
  });
});

describe('PublicBookingContextService.adoptOwnedConversation', () => {
  function build(assertAccess: jest.Mock) {
    return new PublicBookingContextService(
      { query: jest.fn() } as never,
      { assertAccess } as never,
      { patch: jest.fn(), get: jest.fn() } as never,
      { create: jest.fn(), save: jest.fn() } as never,
    );
  }

  it('returns the id when the guest owns it, checking as a guest principal in the guest tenant', async () => {
    const assertAccess = jest.fn().mockResolvedValue(undefined);
    const id = await build(assertAccess).adoptOwnedConversation(
      TENANT,
      GUEST,
      'conv-1',
    );
    expect(id).toBe('conv-1');
    expect(assertAccess).toHaveBeenCalledWith(TENANT, 'conv-1', {
      id: GUEST,
      tenantId: TENANT,
      roles: [],
      permissions: [],
      guest: true,
    });
  });

  it('returns null (never throws, never mints) when access is refused', async () => {
    const assertAccess = jest.fn().mockRejectedValue(new Error('forbidden'));
    await expect(
      build(assertAccess).adoptOwnedConversation(TENANT, GUEST, 'conv-x'),
    ).resolves.toBeNull();
  });
});
