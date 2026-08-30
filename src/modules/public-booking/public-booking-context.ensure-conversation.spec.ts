import { PublicBookingContextService } from './public-booking-context.service';

/**
 * T065 (US4, R16) — `ensureConversation` is the seam that lets the
 * DETERMINISTIC booking flow reuse `getSelection`/`patchSelection`/
 * `requireContext` (all hard-wired to an `aiConversationId`) without a
 * second context store: it mints (or resumes) a bare `AiConversation` row
 * purely as a session key, exactly as `AiOrchestratorService.prepare()`
 * does for the WS path.
 */
const TENANT = 'guest-discovery-tenant';
const GUEST = 'guest-1';

function build(opts: {
  assertAccess?: jest.Mock;
  createdId?: string;
} = {}) {
  const created = { id: opts.createdId ?? 'conv-new' };
  const conversations = {
    create: jest.fn().mockReturnValue(created),
    save: jest.fn().mockResolvedValue(created),
  };
  const access = { assertAccess: opts.assertAccess ?? jest.fn().mockResolvedValue(undefined) };
  const sessions = { patch: jest.fn().mockResolvedValue(undefined), get: jest.fn() };
  const service = new PublicBookingContextService(
    { query: jest.fn() } as never,
    access as never,
    sessions as never,
    conversations as never,
  );
  return { service, conversations, access, sessions };
}

describe('PublicBookingContextService.ensureConversation (T065, US4)', () => {
  it('mints a fresh conversation and binds it to the guest when none was supplied', async () => {
    const { service, conversations, sessions } = build();

    const id = await service.ensureConversation(TENANT, GUEST);

    expect(id).toBe('conv-new');
    expect(conversations.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: { id: TENANT } }),
    );
    expect(sessions.patch).toHaveBeenCalledWith(TENANT, 'conv-new', {
      guestSubject: GUEST,
    });
  });

  it('resumes an existing conversation still owned by this guest — persists across requests within a session', async () => {
    const assertAccess = jest.fn().mockResolvedValue(undefined);
    const { service, conversations } = build({ assertAccess });

    const id = await service.ensureConversation(TENANT, GUEST, 'conv-existing');

    expect(id).toBe('conv-existing');
    expect(assertAccess).toHaveBeenCalledWith(TENANT, 'conv-existing', {
      id: GUEST,
      tenantId: TENANT,
      roles: [],
      permissions: [],
      guest: true,
    });
    expect(conversations.create).not.toHaveBeenCalled();
  });

  it('falls through to a fresh conversation when the supplied id is not owned by this guest', async () => {
    const assertAccess = jest.fn().mockRejectedValue(new Error('not found'));
    const { service, conversations, sessions } = build({ assertAccess });

    const id = await service.ensureConversation(TENANT, GUEST, 'conv-someone-elses');

    expect(id).toBe('conv-new');
    expect(conversations.create).toHaveBeenCalled();
    expect(sessions.patch).toHaveBeenCalledWith(TENANT, 'conv-new', {
      guestSubject: GUEST,
    });
  });
});
