import { IntegrationUpsertService } from './integration-upsert.service';
import { INTEGRATION_RESOURCE } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

/**
 * Outbound sync's change-detection ("what internal records changed since the
 * cursor") lives on `IntegrationUpsertService` alongside the existing
 * `currentViewOf` allowlisted projection it reuses for the actual payload —
 * these tests cover ONLY that read path. The four domain services/repos it
 * also depends on are never invoked here, so they are stubbed out.
 */
function repoMock(rows: unknown[] = []) {
  return { find: jest.fn().mockResolvedValue(rows) } as any;
}

function buildService(repos: { customer?: any; service?: any; staff?: any; appointment?: any } = {}) {
  return new IntegrationUpsertService(
    {} as any, // customers
    {} as any, // servicesSvc
    {} as any, // staffSvc
    {} as any, // appointmentsSvc
    repos.customer ?? repoMock(),
    repos.service ?? repoMock(),
    repos.staff ?? repoMock(),
    repos.appointment ?? repoMock(),
    {} as any, // idMap
    {} as any, // connections
    {} as any, // audit
    {} as any, // conflicts
    undefined, // staffProvisioning (optional)
  );
}

describe('IntegrationUpsertService.listDirtyInternal — outbound change detection', () => {
  const tenantId = 't1';

  it('returns each row with an opaque per-row cursor and hasMore:false when under the limit', async () => {
    const ts = new Date('2024-01-01T00:00:00.000Z');
    const repo = repoMock([{ id: 'a', updated_at: ts }, { id: 'b', updated_at: ts }]);
    const svc = buildService({ customer: repo });

    const page = await svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.CUSTOMER, null, 10);

    expect(page.hasMore).toBe(false);
    expect(page.rows).toEqual([
      { internalId: 'a', cursor: `${ts.toISOString()}|a` },
      { internalId: 'b', cursor: `${ts.toISOString()}|b` },
    ]);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: [{ tenant: { id: tenantId } }], take: 11 }),
    );
  });

  it('signals hasMore:true and trims to `limit` when more rows exist than requested', async () => {
    const ts = new Date();
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `id-${i}`, updated_at: ts }));
    const repo = repoMock(rows);
    const svc = buildService({ service: repo });

    const page = await svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.SERVICE, null, 2);

    expect(page.hasMore).toBe(true);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((r) => r.internalId)).toEqual(['id-0', 'id-1']);
  });

  it('resumes strictly after a decoded cursor via (updated_at > ts) OR (updated_at = ts AND id > id)', async () => {
    const repo = repoMock([]);
    const svc = buildService({ appointment: repo });
    const ts = new Date('2024-06-01T12:00:00.000Z');

    await svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.APPOINTMENT, `${ts.toISOString()}|row-9`, 5);

    const callArgs = repo.find.mock.calls[0][0];
    expect(callArgs.where).toHaveLength(2);
    expect(callArgs.where[1]).toMatchObject({ tenant: { id: tenantId }, updated_at: ts });
    expect(callArgs.take).toBe(6);
  });

  it('rejects a malformed cursor rather than silently starting over from the beginning', async () => {
    const svc = buildService({ staff: repoMock([]) });
    await expect(
      svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.STAFF, 'not-a-real-cursor', 5),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('dispatches to the correct repository per resource type', async () => {
    const customerRepo = repoMock([{ id: 'c', updated_at: new Date() }]);
    const staffRepo = repoMock([{ id: 's', updated_at: new Date() }]);
    const svc = buildService({ customer: customerRepo, staff: staffRepo });

    await svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.CUSTOMER, null, 10);
    await svc.listDirtyInternal(tenantId, INTEGRATION_RESOURCE.STAFF, null, 10);

    expect(customerRepo.find).toHaveBeenCalledTimes(1);
    expect(staffRepo.find).toHaveBeenCalledTimes(1);
  });
});
