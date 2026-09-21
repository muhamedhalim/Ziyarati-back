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
    findTenantRoleBySlug: jest
      .fn()
      .mockImplementation((_tenantId: string, slug: string) =>
        Promise.resolve({ id: 'role-1', slug }),
      ),
    // The REAL `findAll` never loads the `tenant` relation (F-25). This mock
    // used to return `tenant: { id }`, which is exactly what hid the bug: the
    // service filtered on a field production never populates. It now mirrors
    // production, so any code that filters on `role.tenant` fails here too.
    findAll: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve([{ id: 'role-1', slug: 'ai-bot' }]),
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

/**
 * F-25 — after the 60 s cache expired, `ensureBotRole` re-looked the role up by
 * filtering `RolesService.findAll()` on `role.tenant?.id`; `findAll` never
 * loads `tenant`, so it never matched, `create` ran again and threw
 * `ROLE_ALREADY_EXISTS` on every refresh — the bot (and every WhatsApp turn,
 * public booking and waitlist offer that needs it) failed for that tenant
 * from then on.
 */
describe('WhatsappBotActorService — role re-provisioning (F-25)', () => {
  const { AppError, ErrorCode } = jest.requireActual('../../common/errors');

  it('an EXISTING bot role is found by (tenant, slug) and never re-created — including after the cache expires', async () => {
    jest.useFakeTimers({ now: 0 });
    const roles = rolesMock();
    const svc = build(usersMock(), roles, authMock());

    await svc.ensureBotActor('t1');
    jest.advanceTimersByTime(61_000);
    await svc.ensureBotActor('t1');

    expect(roles.findTenantRoleBySlug).toHaveBeenCalledWith('t1', 'ai-bot');
    expect(roles.create).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not depend on `findAll` (which returns roles without their tenant relation)', async () => {
    const roles = rolesMock();
    const svc = build(usersMock(), roles, authMock());

    await svc.ensureBotActor('t1');

    expect(roles.findAll).not.toHaveBeenCalled();
  });

  it('creates the role exactly once when the tenant genuinely has none', async () => {
    const roles = rolesMock({
      findTenantRoleBySlug: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'role-new' }),
    });
    const svc = build(usersMock(), roles, authMock());

    await svc.ensureBotActor('t1');

    expect(roles.create).toHaveBeenCalledTimes(1);
    expect(roles.create.mock.calls[0][0]).toMatchObject({ slug: 'ai-bot' });
    expect(roles.create.mock.calls[0][1]).toBe('t1');
    expect(roles.assignRoleToUser).toHaveBeenCalledWith('user-1', 'role-new', 't1');
  });

  it('a concurrent creator winning the race is recovered by re-reading the SAME (tenant, slug) key', async () => {
    const find = jest
      .fn()
      .mockResolvedValueOnce(null) // first look: not there yet
      .mockResolvedValueOnce({ id: 'role-raced' }); // after ROLE_ALREADY_EXISTS
    const roles = rolesMock({
      findTenantRoleBySlug: find,
      create: jest.fn().mockRejectedValue(new AppError(ErrorCode.ROLE_ALREADY_EXISTS)),
    });
    const svc = build(usersMock(), roles, authMock());

    await svc.ensureBotActor('t1');

    expect(roles.assignRoleToUser).toHaveBeenCalledWith('user-1', 'role-raced', 't1');
  });

  it('ROLE_ALREADY_EXISTS with nothing to reload is still surfaced, not swallowed', async () => {
    const roles = rolesMock({
      findTenantRoleBySlug: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockRejectedValue(new AppError(ErrorCode.ROLE_ALREADY_EXISTS)),
    });
    const svc = build(usersMock(), roles, authMock());

    await expect(svc.ensureBotActor('t1')).rejects.toMatchObject({
      code: ErrorCode.ROLE_ALREADY_EXISTS,
    });
  });
});
