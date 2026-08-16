import { WhatsappBotActorService } from './whatsapp-bot-actor.service';

/**
 * Covers the H4 fix (docs/CACHING_QUEUES_AUDIT.md): the bot-actor principal
 * cache previously had NO TTL at all — a permission revoked mid-session was
 * never picked up until a process restart. Now bounded to 60s, plus an
 * explicit `invalidate()` for immediate-effect callers.
 */

function usersMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue({ id: 'user-1' }),
    create: jest.fn((x) => x),
    save: jest.fn().mockResolvedValue({ id: 'user-1' }),
    ...over,
  } as any;
}

function rolesMock(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    // Pre-seeded so `ensureBotRole` finds it and never has to call `create`
    // (matching real behaviour once the bot role exists, and matching
    // `ROLE.AI_BOT`'s real slug — 'ai-bot', not an invented placeholder).
    findAll: jest
      .fn()
      .mockImplementation((tenantId: string) =>
        Promise.resolve([
          { id: 'role-1', slug: 'ai-bot', tenant: { id: tenantId } },
        ]),
      ),
    create: jest.fn(),
    assignRoleToUser: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as any;
}

function authMock(
  principal: unknown = { id: 'user-1', permissions: ['appointment.create'] },
) {
  return {
    buildAuthenticatedUser: jest.fn().mockResolvedValue(principal),
  } as any;
}

function build(users: any, roles: any, auth: any) {
  return new WhatsappBotActorService(users, roles, auth);
}

describe('WhatsappBotActorService — cache TTL and invalidation (H4)', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  it('reuses the cached principal within the TTL window (no re-lookup)', async () => {
    const users = usersMock();
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('t1');
    await svc.ensureBotActor('t1');

    expect(auth.buildAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it('re-reads the principal once the TTL has elapsed — a revoked permission is not granted forever', async () => {
    jest.useFakeTimers({ now: 0 });
    const users = usersMock();
    const roles = rolesMock();
    const first = { id: 'user-1', permissions: ['appointment.create'] };
    const second = { id: 'user-1', permissions: [] }; // permission revoked
    const auth = {
      buildAuthenticatedUser: jest
        .fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second),
    } as any;
    const svc = build(users, roles, auth);

    const p1 = await svc.ensureBotActor('t1');
    expect(p1.permissions).toEqual(['appointment.create']);

    jest.advanceTimersByTime(61_000); // past the 60s TTL

    const p2 = await svc.ensureBotActor('t1');
    expect(p2.permissions).toEqual([]);
    expect(auth.buildAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces an immediate re-read regardless of TTL', async () => {
    const users = usersMock();
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('t1');
    svc.invalidate('t1');
    await svc.ensureBotActor('t1');

    expect(auth.buildAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it('invalidate() on an uncached/unknown tenant is a safe no-op', () => {
    const svc = build(usersMock(), rolesMock(), authMock());
    expect(() => svc.invalidate('never-cached')).not.toThrow();
  });

  it('caches per-tenant independently', async () => {
    const users = usersMock();
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('t1');
    await svc.ensureBotActor('t2');
    await svc.ensureBotActor('t1');
    await svc.ensureBotActor('t2');

    expect(auth.buildAuthenticatedUser).toHaveBeenCalledTimes(2);
  });
});

/**
 * AI-001 (T021/T021a) — `users.email` is unique GLOBALLY
 * (`uq_user_email_global`), not per tenant, so the bot actor's address must
 * be tenant-qualified (RFC 5233 sub-addressing, R10) at BOTH the lookup and
 * the insert, or the two diverge and a legitimately-created row becomes
 * unfindable on the next call.
 */
describe('WhatsappBotActorService — tenant-qualified bot email (AI-001)', () => {
  it('looks up an existing bot row by the TENANT-QUALIFIED address, not the bare legacy literal', async () => {
    const users = usersMock();
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('tenant-a');

    expect(users.findOne).toHaveBeenCalledWith({
      where: { tenant: { id: 'tenant-a' }, email: 'ai-bot+tenant-a@bot.internal' },
    });
    const [[arg]] = users.findOne.mock.calls;
    expect(arg.where.email).not.toBe('ai-bot@bot.internal');
  });

  it('creates a new bot row with the SAME tenant-qualified address the lookup used', async () => {
    const users = usersMock({ findOne: jest.fn().mockResolvedValue(undefined) });
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('tenant-a');

    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ai-bot+tenant-a@bot.internal' }),
    );
    const [lookupArg] = users.findOne.mock.calls[0];
    const [createArg] = users.create.mock.calls[0];
    expect(createArg.email).toBe(lookupArg.where.email); // lookup and insert never diverge
  });

  it('two distinct tenants receive two distinct, deterministic addresses', async () => {
    const users = usersMock({ findOne: jest.fn().mockResolvedValue(undefined) });
    const roles = rolesMock();
    const auth = authMock();
    const svc = build(users, roles, auth);

    await svc.ensureBotActor('tenant-a');
    await svc.ensureBotActor('tenant-b');

    const emails = users.create.mock.calls.map((c: [{ email: string }]) => c[0].email);
    expect(emails).toEqual([
      'ai-bot+tenant-a@bot.internal',
      'ai-bot+tenant-b@bot.internal',
    ]);
    expect(new Set(emails).size).toBe(2); // distinct — this is exactly what AI-001's fix must guarantee
  });
});
