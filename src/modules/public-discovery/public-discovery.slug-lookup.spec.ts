import { PublicDiscoveryService } from './public-discovery.service';
import { ErrorCode } from '../../common/errors';

/**
 * Contract C2a — `clinicDetail()` accepts a UUID or a slug. The UUID path must
 * stay byte-identical (same query shape, same params); the slug path is new.
 */

const UUID = '11111111-1111-1111-1111-111111111111';
const SLUG = 'noor-dental';

const TENANT_ROW = { id: UUID, name: 'Noor Dental', slug: SLUG, logo_url: null };

function build(tenantRows: Record<string, unknown>[]) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('FROM tenants t')) return tenantRows;
    // branches / services / doctors sub-queries — irrelevant to this contract
    return [];
  });
  const service = new PublicDiscoveryService(
    { query } as never,
    {} as never,
  );
  return { service, query };
}

describe('PublicDiscoveryService.clinicDetail — slug lookup (C2a)', () => {
  it('resolves by UUID exactly as before (byte-identical query)', async () => {
    const { service, query } = build([TENANT_ROW]);

    const detail = await service.clinicDetail(UUID);

    expect(detail.clinic.id).toBe(UUID);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('t.id = $1::uuid');
    expect(sql).not.toContain('t.slug = $1');
    expect(params).toEqual([UUID]);
  });

  it('resolves by slug when the identifier is not UUID-shaped', async () => {
    const { service, query } = build([TENANT_ROW]);

    const detail = await service.clinicDetail(SLUG);

    expect(detail.clinic.slug).toBe(SLUG);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('t.slug = $1');
    expect(sql).not.toContain('t.id = $1::uuid');
    expect(params).toEqual([SLUG]);
  });

  it('returns identical payloads for the same clinic via UUID or slug', async () => {
    const byUuid = build([TENANT_ROW]);
    const bySlug = build([TENANT_ROW]);

    const a = await byUuid.service.clinicDetail(UUID);
    const b = await bySlug.service.clinicDetail(SLUG);

    expect(a.clinic).toEqual(b.clinic);
  });

  it('404s (never a raw DB error) for a malformed, non-UUID, non-matching identifier', async () => {
    const { service } = build([]);

    await expect(service.clinicDetail('not-a-real-slug-or-uuid')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('404s identically for a de-listed clinic looked up by slug', async () => {
    const { service } = build([]); // ELIGIBLE_CLINIC predicate excluded it — empty result

    await expect(service.clinicDetail(SLUG)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('resolves downstream branch/service/doctor queries against the RESOLVED uuid, not the caller-supplied slug', async () => {
    const { service, query } = build([TENANT_ROW]);

    await service.clinicDetail(SLUG);

    const branchCall = query.mock.calls.find((c) => (c[0] as string).includes('FROM branches b'));
    expect(branchCall?.[1]).toEqual([UUID]);
  });
});
