import { AiToolDispatchService } from './ai-tool-dispatch.service';
import { AI_TOOL } from './ai-tools.constants';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * The WhatsApp channel's own-clinic discovery tools
 * (`list_clinic_branches` / `list_clinic_doctors` / `list_clinic_services`).
 *
 * Unlike the guest discovery tools (`search_clinics` et al.), these serve an
 * AUTHENTICATED turn (the tenant's own AI bot actor — see
 * `WhatsappBotActorService`) that has no public booking session to resolve a
 * branch from, and no `clinicId` to pass `get_clinic_details` — it already
 * represents exactly one clinic: `ctx.tenantId`.
 *
 * What matters most here is what these tools do NOT do: they must never take
 * a tenant from anywhere but `ctx.tenantId`, and a `branchId` from another
 * tenant must produce a plain refusal — never branch info, doctors,
 * services, or any other data (see the security model in
 * `ai-tool-dispatch.service.ts`'s own class docblock).
 */

const TENANT_A = 'tenant-a';
const BRANCH_ID = '11111111-1111-4111-8111-111111111111';

const CTX_AUTHENTICATED = {
  tenantId: TENANT_A,
  aiConversationId: 'conv-1',
  actorUserId: 'bot-user-1',
  permissions: [],
} as never;

const CTX_NO_ACTOR = {
  tenantId: TENANT_A,
  aiConversationId: 'conv-1',
  permissions: [],
} as never;

/** Mirrors the build() helper in ai-tool-dispatch.public-city.spec.ts. */
function build(overrides: {
  branches?: Record<string, unknown>;
  discovery?: Record<string, unknown>;
}) {
  // `run()`'s idempotency ledger: no prior row for this key, and the claim
  // INSERT wins (returns an id). Every other query (the EXECUTING/SUCCEEDED/
  // FAILED_PERMANENT status updates) is a no-op update whose return value is
  // unused — captured on the mock so tests can assert what was recorded.
  const dataSource = {
    query: jest
      .fn()
      .mockImplementation(async (sql: string) =>
        /INSERT INTO ai_tool_calls[\s\S]*RETURNING id/.test(sql)
          ? [{ id: 'claim-1' }]
          : [],
      ),
  };
  const tenantContext = { getCorrelationId: jest.fn().mockReturnValue(null) };
  const branches = {
    findAll: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({}),
    ...overrides.branches,
  };
  const discovery = {
    listBranchDoctors: jest.fn().mockResolvedValue([]),
    listBranchServices: jest.fn().mockResolvedValue([]),
    ...overrides.discovery,
  };
  const service = new AiToolDispatchService(
    {} as never, // appointments
    {} as never, // availability
    discovery as never,
    {} as never, // dashboardMetrics
    {} as never, // subscriptions
    {} as never, // usage
    {} as never, // customers
    {} as never, // staff
    {} as never, // aiAnalytics
    dataSource as never,
    {} as never, // handovers
    {} as never, // tenants
    {} as never, // paymentLinks
    {} as never, // bookingContext
    {} as never, // botActor
    tenantContext as never,
    {} as never, // sessions
    branches as never,
  );
  return { service, dataSource, branches, discovery };
}

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'c1',
  name,
  arguments: JSON.stringify(args),
});

/** True iff the ledger recorded a FAILED_PERMANENT row for this call. */
function recordedFailedPermanent(dataSource: { query: jest.Mock }): boolean {
  return dataSource.query.mock.calls.some(
    ([sql, params]: [string, unknown[]]) =>
      /UPDATE ai_tool_calls SET status=\$2/.test(sql) &&
      params?.[1] === 'FAILED_PERMANENT',
  );
}

describe('list_clinic_branches', () => {
  it('is refused with no acting user (guest reachability closed)', async () => {
    const { service, branches } = build({});
    const result: Record<string, unknown> = await service.execute(
      CTX_NO_ACTOR,
      call(AI_TOOL.LIST_CLINIC_BRANCHES),
    );
    expect(result.success).toBe(false);
    expect(branches.findAll).not.toHaveBeenCalled();
  });

  it('takes the tenant ONLY from ctx.tenantId, filters inactive, and projects only {id, name, address}', async () => {
    const { service, branches } = build({
      branches: {
        findAll: jest.fn().mockResolvedValue([
          {
            id: 'b-active',
            name: 'Main Branch',
            address: '123 Main St',
            is_active: true,
            // Fields that must NOT leak into the tool result — BranchService's
            // findAll() returns the full entity, and the tool must project it
            // down before handing it to the model.
            phone: '+20-secret',
            whatsapp_phone: '+20-secret-wa',
            timezone: 'Africa/Cairo',
          },
          {
            id: 'b-inactive',
            name: 'Closed Branch',
            address: 'Nowhere',
            is_active: false,
          },
        ]),
      },
    });

    const result: Record<string, unknown> = await service.execute(
      CTX_AUTHENTICATED,
      call(AI_TOOL.LIST_CLINIC_BRANCHES),
    );

    expect(branches.findAll).toHaveBeenCalledWith(TENANT_A);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.branches).toEqual([
      { id: 'b-active', name: 'Main Branch', address: '123 Main St' },
    ]);
    // The inactive branch, and every extra field on the active one, must be
    // absent — not merely unused.
    const serialized = JSON.stringify(result.branches);
    expect(serialized).not.toContain('b-inactive');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('Africa/Cairo');
  });

  it('is recorded in ai_tool_calls', async () => {
    const { service, dataSource } = build({});
    await service.execute(CTX_AUTHENTICATED, call(AI_TOOL.LIST_CLINIC_BRANCHES));
    expect(
      dataSource.query.mock.calls.some(([sql]: [string]) =>
        /INSERT INTO ai_tool_calls/.test(sql),
      ),
    ).toBe(true);
  });
});

describe.each([
  {
    tool: AI_TOOL.LIST_CLINIC_DOCTORS,
    discoveryMethod: 'listBranchDoctors',
    resultKey: 'doctors',
  },
  {
    tool: AI_TOOL.LIST_CLINIC_SERVICES,
    discoveryMethod: 'listBranchServices',
    resultKey: 'services',
  },
])('$tool', ({ tool, discoveryMethod, resultKey }) => {
  it('is refused with no acting user', async () => {
    const { service, branches } = build({});
    const result: Record<string, unknown> = await service.execute(
      CTX_NO_ACTOR,
      call(tool, { branchId: BRANCH_ID }),
    );
    expect(result.success).toBe(false);
    expect(branches.findOne).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID branchId without touching the database', async () => {
    const { service, branches, discovery } = build({});
    const result: Record<string, unknown> = await service.execute(
      CTX_AUTHENTICATED,
      call(tool, { branchId: 'owner@some-clinic' }),
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toMatch(/list_clinic_branches/);
    expect(branches.findOne).not.toHaveBeenCalled();
    expect((discovery as never as Record<string, jest.Mock>)[discoveryMethod]).not.toHaveBeenCalled();
  });

  it('CROSS-TENANT: a branchId belonging to another tenant is refused, never exposes data, and is checked against ctx.tenantId only', async () => {
    const { service, branches, discovery, dataSource } = build({
      branches: {
        findOne: jest
          .fn()
          .mockRejectedValue(
            new AppError(ErrorCode.NOT_FOUND, { message: 'Branch not found' }),
          ),
      },
    });

    const result: Record<string, unknown> = await service.execute(
      CTX_AUTHENTICATED,
      call(tool, { branchId: BRANCH_ID }),
    );

    // Tenant is asserted from ctx.tenantId — never a value the model could
    // have influenced (there is no tenantId/clinicId parameter on this tool).
    expect(branches.findOne).toHaveBeenCalledWith(TENANT_A, BRANCH_ID);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Branch not found');
    // The refusal must be a plain error, not silently-empty data that reads
    // as "this branch has none" — and the underlying discovery call for
    // another tenant's branch must never even run.
    expect((discovery as never as Record<string, jest.Mock>)[discoveryMethod]).not.toHaveBeenCalled();
    expect(recordedFailedPermanent(dataSource)).toBe(true);
  });

  it('on a branch that belongs to THIS tenant, returns the discovery result scoped to ctx.tenantId', async () => {
    const rows = [{ id: 'row-1', name: 'Dr. Test' }];
    const { service, discovery } = build({
      branches: { findOne: jest.fn().mockResolvedValue({ id: BRANCH_ID }) },
      discovery: {
        [discoveryMethod]: jest.fn().mockResolvedValue(rows),
      },
    });

    const result: Record<string, unknown> = await service.execute(
      CTX_AUTHENTICATED,
      call(tool, { branchId: BRANCH_ID }),
    );

    expect(
      (discovery as never as Record<string, jest.Mock>)[discoveryMethod],
    ).toHaveBeenCalledWith(TENANT_A, BRANCH_ID);
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result[resultKey]).toEqual(rows);
  });
});
