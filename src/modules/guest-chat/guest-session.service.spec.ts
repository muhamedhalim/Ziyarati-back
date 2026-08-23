import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';

import { GuestSessionService } from './guest-session.service';
import { ErrorCode } from '../../common/errors';
import { AI_CONVERSATION_STATUS } from '../ai/ai.constants';
import { createMockConfigService } from '../../../test/utils/mock-factories';

/**
 * Security regression suite for FND-001 (P0) — unauthenticated cross-tenant
 * AI-memory read/write through the public guest-conversion endpoint.
 *
 * The original defect: the endpoint was public and took BOTH the source
 * conversation id AND the target tenant id straight from the request body, then
 * read `ai_messages` with no tenant predicate. An attacker chose the read
 * boundary and the write boundary.
 *
 * After remediation the target tenant comes from the authenticated principal and
 * the source conversation must be proven to belong to the caller's own guest
 * session, via the `guestSubject` recorded on the conversation at creation.
 */

const DISCOVERY_TENANT = 'discovery-tenant-id';
const TENANT_A = 'tenant-a-id';
const TENANT_B = 'tenant-b-id';
const GUEST_A = 'guest-a-subject';
const GUEST_B = 'guest-b-subject';
const CONV_A = '11111111-1111-4111-8111-111111111111';

/** Signs a guest token with the same shape `resolveSession()` mints. */
function guestToken(
  jwt: JwtService,
  sub: string,
  tenantId: string,
  expired = false,
): Promise<string> {
  return jwt.signAsync(
    { sub, tenantId, guest: true },
    { secret: 'test-access-secret', expiresIn: expired ? '-1s' : '1d' },
  );
}

describe('GuestSessionService.convert — FND-001', () => {
  let service: GuestSessionService;
  let jwt: JwtService;
  let tenants: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let memory: { summarizeConversation: jest.Mock };
  let overrides: { hasActive: jest.Mock; grant: jest.Mock };
  let config: ReturnType<typeof createMockConfigService>;
  let conversationRepo: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let auditLogs: { create: jest.Mock; save: jest.Mock };
  let updateResult: { affected: number };

  /** Builds a conversation row as the repository would return it. */
  const conversationRow = (opts: {
    guestSubject?: string;
    tenantId?: string;
    status?: string;
  }) => ({
    id: CONV_A,
    tenant: { id: opts.tenantId ?? DISCOVERY_TENANT },
    status: opts.status ?? AI_CONVERSATION_STATUS.ACTIVE,
    session: opts.guestSubject ? { guestSubject: opts.guestSubject } : {},
  });

  beforeEach(() => {
    jwt = new JwtService({});
    tenants = {
      findOne: jest.fn().mockResolvedValue({
        id: DISCOVERY_TENANT,
        slug: '__guest_discovery__',
      }),
      save: jest.fn(),
      create: jest.fn(),
    };
    memory = {
      summarizeConversation: jest.fn().mockResolvedValue({ id: 'memory-1' }),
    };
    overrides = {
      hasActive: jest.fn().mockResolvedValue(true),
      grant: jest.fn(),
    };
    config = createMockConfigService({
      JWT_ACCESS_SECRET: 'test-access-secret',
    });

    updateResult = { affected: 1 };
    conversationRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue(conversationRow({ guestSubject: GUEST_A })),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockImplementation(async () => updateResult),
      }),
    };
    auditLogs = {
      create: jest.fn().mockImplementation((entry) => entry),
      save: jest.fn().mockResolvedValue(undefined),
    };

    service = new GuestSessionService(
      tenants as never,
      jwt,
      config as never,
      overrides as never,
      memory as never,
      conversationRepo as never,
      auditLogs as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  /** Asserts a rejection is the uniform not-found, disclosing nothing (SR-011). */
  const expectUniformRejection = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  };

  describe('trusted tenant derivation (FR-001, SR-001)', () => {
    it('writes memory to the authenticated principal tenant, never a caller-supplied one', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);

      expect(memory.summarizeConversation).toHaveBeenCalledTimes(1);
      const [targetTenant, conversationId, , sourceTenant] =
        memory.summarizeConversation.mock.calls[0];
      expect(targetTenant).toBe(TENANT_A);
      expect(conversationId).toBe(CONV_A);
      // The source read must be scoped to the discovery tenant, not the target.
      expect(sourceTenant).toBe(DISCOVERY_TENANT);
    });

    it('never passes tenant B to the memory write when the principal is tenant A', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);
      expect(memory.summarizeConversation).not.toHaveBeenCalledWith(
        TENANT_B,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });
  });

  describe('guest-session verification (FR-002, FR-003)', () => {
    it('rejects a missing guest token', async () => {
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, undefined, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });

    it('rejects an empty guest token', async () => {
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, '', undefined),
      );
    });

    it('rejects an expired guest token', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT, true);
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });

    it('rejects a malformed guest token', async () => {
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, 'not.a.jwt', undefined),
      );
    });

    it('rejects a token signed with the wrong secret', async () => {
      const token = await jwt.signAsync(
        { sub: GUEST_A, tenantId: DISCOVERY_TENANT, guest: true },
        { secret: 'attacker-secret', expiresIn: '1d' },
      );
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
    });

    it('rejects a non-guest token (guest flag absent)', async () => {
      const token = await jwt.signAsync(
        { sub: GUEST_A, tenantId: DISCOVERY_TENANT },
        { secret: 'test-access-secret', expiresIn: '1d' },
      );
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
    });

    it('rejects a guest token whose tenant is not the discovery tenant', async () => {
      const token = await guestToken(jwt, GUEST_A, TENANT_B);
      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });
  });

  // ZT-007: getOrThrow must fail loudly on a missing secret, distinguishably
  // from a merely-invalid token (both used to collapse into the same
  // uniform not-found response before the secret was resolved outside the
  // verification try/catch).
  describe('fails loudly when JWT_ACCESS_SECRET is unset (ZT-007)', () => {
    it('resolveSession (minting — no token presented) raises rather than signing under no secret', async () => {
      const svc = new GuestSessionService(
        tenants as never,
        jwt,
        createMockConfigService({}) as never,
        overrides as never,
        memory as never,
        conversationRepo as never,
        auditLogs as never,
      );
      await expect(svc.resolveSession()).rejects.toThrow(/JWT_ACCESS_SECRET/);
    });

    it('convert (verification) raises rather than returning the uniform not-found', async () => {
      const svc = new GuestSessionService(
        tenants as never,
        jwt,
        createMockConfigService({}) as never,
        overrides as never,
        memory as never,
        conversationRepo as never,
        auditLogs as never,
      );
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await expect(
        svc.convert(CONV_A, TENANT_A, token, undefined),
      ).rejects.toThrow(/JWT_ACCESS_SECRET/);
    });
  });

  describe('source-conversation ownership — the IDOR case (FR-005, Scenario 2)', () => {
    it('rejects guest A converting guest B conversation inside the same discovery tenant', async () => {
      conversationRepo.findOne.mockResolvedValue(
        conversationRow({ guestSubject: GUEST_B }),
      );
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });

    it('rejects a legacy conversation carrying no guestSubject binding (fail closed)', async () => {
      conversationRepo.findOne.mockResolvedValue(conversationRow({}));
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });

    it('rejects a conversation that does not exist', async () => {
      conversationRepo.findOne.mockResolvedValue(null);
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
    });

    it('scopes the conversation lookup to the discovery tenant', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);

      const where = conversationRepo.findOne.mock.calls[0][0].where;
      expect(where).toMatchObject({
        id: CONV_A,
        tenant: { id: DISCOVERY_TENANT },
      });
    });
  });

  describe('atomic, idempotent conversion (FR-003, DI-001)', () => {
    it('rejects a conversation that was already converted (zero rows affected)', async () => {
      updateResult = { affected: 0 };
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      await expectUniformRejection(
        service.convert(CONV_A, TENANT_A, token, undefined),
      );
      expect(memory.summarizeConversation).not.toHaveBeenCalled();
    });

    it('claims the conversion with a conditional update, not a read-modify-write save', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);

      // A conditional UPDATE is what makes concurrent conversion safe; `.save()`
      // would lose the update under concurrency.
      expect(conversationRepo.createQueryBuilder).toHaveBeenCalled();
      expect(
        (conversationRepo as unknown as { save?: unknown }).save,
      ).toBeUndefined();
    });

    it('AI-002 — the claim predicate references the column that actually exists ("tenantId", not "tenant_id")', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);

      const builder = conversationRepo.createQueryBuilder.mock.results[0]
        .value as { andWhere: jest.Mock };
      const tenantPredicateCall = builder.andWhere.mock.calls.find(
        (call: unknown[]) => (call[0] as string).includes('tenantId'),
      );
      expect(tenantPredicateCall).toBeDefined();
      expect(tenantPredicateCall![0]).toBe('"tenantId" = :tenantId');
      expect(tenantPredicateCall![0]).not.toContain('tenant_id'); // the column TypeORM's default naming strategy actually produced for an unqualified relation
      expect(tenantPredicateCall![1]).toEqual({ tenantId: DISCOVERY_TENANT });
    });

    it('writes at most one memory record when two conversions race', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      let claims = 0;
      conversationRepo.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        // Only the first claim affects a row — exactly what the DB guarantees.
        execute: jest.fn().mockImplementation(async () => ({
          affected: claims++ === 0 ? 1 : 0,
        })),
      });

      const results = await Promise.allSettled([
        service.convert(CONV_A, TENANT_A, token, undefined),
        service.convert(CONV_A, TENANT_A, token, undefined),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(memory.summarizeConversation).toHaveBeenCalledTimes(1);
    });
  });

  describe('uniform rejection responses (SR-011)', () => {
    it('returns an indistinguishable error for every ownership failure mode', async () => {
      const validToken = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      const expiredToken = await guestToken(
        jwt,
        GUEST_A,
        DISCOVERY_TENANT,
        true,
      );
      const foreignTenantToken = await guestToken(jwt, GUEST_A, TENANT_B);

      const attempts: Array<() => Promise<unknown>> = [
        // missing token
        () => service.convert(CONV_A, TENANT_A, undefined, undefined),
        // expired token
        () => service.convert(CONV_A, TENANT_A, expiredToken, undefined),
        // token for the wrong tenant
        () => service.convert(CONV_A, TENANT_A, foreignTenantToken, undefined),
        // another guest's conversation
        () => {
          conversationRepo.findOne.mockResolvedValue(
            conversationRow({ guestSubject: GUEST_B }),
          );
          return service.convert(CONV_A, TENANT_A, validToken, undefined);
        },
        // legacy unbound conversation
        () => {
          conversationRepo.findOne.mockResolvedValue(conversationRow({}));
          return service.convert(CONV_A, TENANT_A, validToken, undefined);
        },
        // non-existent conversation
        () => {
          conversationRepo.findOne.mockResolvedValue(null);
          return service.convert(CONV_A, TENANT_A, validToken, undefined);
        },
      ];

      const codes: string[] = [];
      const messages: string[] = [];
      for (const attempt of attempts) {
        try {
          await attempt();
          throw new Error('expected a rejection');
        } catch (err) {
          codes.push((err as { code: string }).code);
          messages.push((err as { message: string }).message);
        }
      }

      // Every failure mode must be indistinguishable to the caller.
      expect(new Set(codes).size).toBe(1);
      expect(new Set(messages).size).toBe(1);
    });
  });

  // AI-018 (FR-037-039, RTP row 15): exactly one audit entry per successful
  // conversion, and a failing audit write must never fail or roll back the
  // conversion itself.
  describe('conversion audit entry (FR-037-039)', () => {
    it('writes exactly one audit_logs entry, naming the created memory', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      const result = await service.convert(
        CONV_A,
        TENANT_A,
        token,
        undefined,
        'user-1',
      );

      expect(auditLogs.save).toHaveBeenCalledTimes(1);
      const entry = auditLogs.create.mock.calls[0][0];
      expect(entry).toMatchObject({
        tenant: { id: TENANT_A },
        user: { id: 'user-1' },
        action: 'guest.conversion.converted',
        entity_type: 'ai_memory',
        entity_id: 'memory-1',
      });
      expect(result).toEqual({ converted: true, memoryId: 'memory-1' });
    });

    it('names the converted conversation when summarization produced no memory', async () => {
      memory.summarizeConversation.mockResolvedValueOnce(null);
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined, 'user-1');

      const entry = auditLogs.create.mock.calls[0][0];
      expect(entry).toMatchObject({
        entity_type: 'ai_conversation',
        entity_id: CONV_A,
      });
    });

    it('omits the user relation when no actorUserId is supplied', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined);

      const entry = auditLogs.create.mock.calls[0][0];
      expect(entry.user).toBeUndefined();
    });

    it('never carries message content in the audit entry (FR-088)', async () => {
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);
      await service.convert(CONV_A, TENANT_A, token, undefined, 'user-1');

      const entry = auditLogs.create.mock.calls[0][0];
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('content');
    });

    it('does not fail or roll back the conversion when the audit write throws (FR-039)', async () => {
      auditLogs.save.mockRejectedValueOnce(new Error('db unavailable'));
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      const result = await service.convert(
        CONV_A,
        TENANT_A,
        token,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ converted: true, memoryId: 'memory-1' });
    });

    it('does not fail or roll back the conversion when the audit repository is entirely unavailable', async () => {
      const svc = new GuestSessionService(
        tenants as never,
        jwt,
        config as never,
        overrides as never,
        memory as never,
        conversationRepo as never,
        undefined as never,
      );
      const token = await guestToken(jwt, GUEST_A, DISCOVERY_TENANT);

      const result = await svc.convert(
        CONV_A,
        TENANT_A,
        token,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ converted: true, memoryId: 'memory-1' });
    });
  });
});

/**
 * Guest-identity-churn fix: `POST /public/guest/session` must be idempotent —
 * reusing a still-valid `guest_token` instead of always minting a new
 * identity is what stops a widget remount from orphaning
 * `session.guestSubject` on a conversation the visitor already has cached
 * client-side (see the "AI conversation not found" root-cause writeup).
 */
describe('GuestSessionService.resolveSession — idempotent guest identity', () => {
  let service: GuestSessionService;
  let jwt: JwtService;
  let tenants: { findOne: jest.Mock; save: jest.Mock; create: jest.Mock };
  let overrides: { hasActive: jest.Mock; grant: jest.Mock };
  let config: ReturnType<typeof createMockConfigService>;
  let loggerWarnSpy: jest.SpyInstance;

  const DISCOVERY_TENANT = 'discovery-tenant-id';
  const OTHER_TENANT = 'other-tenant-id';

  const sign = (
    claims: Record<string, unknown>,
    opts: { secret?: string; expiresIn?: string } = {},
  ) =>
    jwt.signAsync(claims, {
      secret: opts.secret ?? 'test-access-secret',
      expiresIn: (opts.expiresIn ?? '1d') as never,
    });

  beforeEach(() => {
    jwt = new JwtService({});
    tenants = {
      findOne: jest.fn().mockResolvedValue({
        id: DISCOVERY_TENANT,
        slug: '__guest_discovery__',
      }),
      save: jest.fn(),
      create: jest.fn(),
    };
    overrides = {
      hasActive: jest.fn().mockResolvedValue(true),
      grant: jest.fn(),
    };
    config = createMockConfigService({
      JWT_ACCESS_SECRET: 'test-access-secret',
    });
    loggerWarnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    service = new GuestSessionService(
      tenants as never,
      jwt,
      config as never,
      overrides as never,
      { summarizeConversation: jest.fn() } as never,
      { findOne: jest.fn(), createQueryBuilder: jest.fn() } as never,
      { create: jest.fn(), save: jest.fn() } as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('[Test 1] mints a fresh guestId when no token is presented', async () => {
    const result = await service.resolveSession(undefined);
    expect(result.isNew).toBe(true);
    expect(result.guestId).toEqual(expect.any(String));
    expect(result.tenantId).toBe(DISCOVERY_TENANT);
  });

  it('[Test 2] reuses the SAME guestId on a second call with the token from the first — never mints a second identity', async () => {
    const first = await service.resolveSession(undefined);
    const second = await service.resolveSession(first.token);

    expect(second.isNew).toBe(false);
    expect(second.guestId).toBe(first.guestId);
    expect(second.token).toBe(first.token); // untouched — never re-signed
  });

  it('[Test 13] mints a NEW identity — and does not reuse the old conversationId binding — when the presented token is expired', async () => {
    const expired = await sign(
      { sub: 'guest-old', tenantId: DISCOVERY_TENANT, guest: true },
      { expiresIn: '-1s' },
    );
    const result = await service.resolveSession(expired);
    expect(result.isNew).toBe(true);
    expect(result.guestId).not.toBe('guest-old');
  });

  it('mints a NEW identity when the presented token is signed with the wrong secret (forged)', async () => {
    const forged = await sign(
      { sub: 'attacker', tenantId: DISCOVERY_TENANT, guest: true },
      { secret: 'attacker-secret' },
    );
    const result = await service.resolveSession(forged);
    expect(result.isNew).toBe(true);
    expect(result.guestId).not.toBe('attacker');
  });

  it('mints a NEW identity when the presented token is not a guest token', async () => {
    const staffLike = await sign({ sub: 'user-1', tenantId: DISCOVERY_TENANT });
    const result = await service.resolveSession(staffLike);
    expect(result.isNew).toBe(true);
  });

  it('mints a NEW identity when the presented token belongs to a different tenant', async () => {
    const foreign = await sign({
      sub: 'guest-foreign',
      tenantId: OTHER_TENANT,
      guest: true,
    });
    const result = await service.resolveSession(foreign);
    expect(result.isNew).toBe(true);
    expect(result.guestId).not.toBe('guest-foreign');
  });

  it('mints a NEW identity when the presented token is malformed', async () => {
    const result = await service.resolveSession('not.a.jwt');
    expect(result.isNew).toBe(true);
  });

  describe('[Test 12] TTL — JWT expiry and cookie Max-Age never drift apart', () => {
    it('derives maxAgeMs from the exact GUEST_SESSION_TTL used to sign the token (default)', async () => {
      const result = await service.resolveSession(undefined);
      expect(result.maxAgeMs).toBe(24 * 60 * 60 * 1000); // '1d'
    });

    it('derives maxAgeMs from a custom, valid GUEST_SESSION_TTL', async () => {
      const svc = new GuestSessionService(
        tenants as never,
        jwt,
        createMockConfigService({
          JWT_ACCESS_SECRET: 'test-access-secret',
          GUEST_SESSION_TTL: '12h',
        }) as never,
        overrides as never,
        { summarizeConversation: jest.fn() } as never,
        { findOne: jest.fn(), createQueryBuilder: jest.fn() } as never,
        { create: jest.fn(), save: jest.fn() } as never,
      );
      const result = await svc.resolveSession(undefined);
      expect(result.maxAgeMs).toBe(12 * 60 * 60 * 1000);
    });

    it('falls back to the safe default and warns when GUEST_SESSION_TTL is malformed, rather than zeroing the cookie or throwing', async () => {
      const svc = new GuestSessionService(
        tenants as never,
        jwt,
        createMockConfigService({
          JWT_ACCESS_SECRET: 'test-access-secret',
          GUEST_SESSION_TTL: 'not-a-duration',
        }) as never,
        overrides as never,
        { summarizeConversation: jest.fn() } as never,
        { findOne: jest.fn(), createQueryBuilder: jest.fn() } as never,
        { create: jest.fn(), save: jest.fn() } as never,
      );
      const result = await svc.resolveSession(undefined);
      expect(result.maxAgeMs).toBe(24 * 60 * 60 * 1000); // falls back to '1d'
      expect(result.maxAgeMs).toBeGreaterThan(0);
      expect(loggerWarnSpy).toHaveBeenCalled();
    });
  });
});
