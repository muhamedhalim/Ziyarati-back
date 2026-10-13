import { PublicDiscoveryService } from './public-discovery.service';

/**
 * Contract C13 — the public index of clinic-managed service categories, and the
 * `categorySlug` filter on the services search. Raw-SQL service, so (as in the
 * sibling specs) `DataSource.query` is mocked and the SQL is asserted on for the
 * visibility predicate; the grouping/slug/sampling logic is exercised on rows.
 */

interface CategoryRow {
  id: string;
  name: string;
  tenant_id: string;
  service_count: number;
}
interface SampleRow {
  category_id: string;
  public_slug: string;
  name: string;
  clinic_name: string;
  clinic_slug: string;
}

function buildIndex(opts: {
  categories?: CategoryRow[];
  samples?: SampleRow[];
}) {
  const query = jest.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('CROSS JOIN LATERAL')) return opts.samples ?? [];
    if (sql.includes('GROUP BY sc.id, sc.name, t.id'))
      return opts.categories ?? [];
    return [];
  });
  const service = new PublicDiscoveryService({ query } as never, {} as never);
  return { service, query };
}

const cat = (
  id: string,
  name: string,
  tenant: string,
  services = 1,
): CategoryRow => ({
  id,
  name,
  tenant_id: tenant,
  service_count: services,
});

describe('PublicDiscoveryService.listCategories (C13)', () => {
  it('folds the same wording across clinics into one public category with a derived slug', async () => {
    const { service } = buildIndex({
      categories: [
        cat('c1', 'Dental', 't1', 2),
        cat('c2', '  dental ', 't2', 1),
        cat('c3', 'Laser Treatments', 't1', 1),
      ],
    });
    const result = await service.listCategories();
    expect(result.map((c) => c.slug)).toEqual(['dental', 'laser-treatments']);
    expect(result[0]).toMatchObject({
      slug: 'dental',
      clinicCount: 2,
      serviceCount: 3,
    });
  });

  it('shows the wording most clinics use, ties falling to a stable alphabetical pick', async () => {
    const { service } = buildIndex({
      categories: [
        cat('c1', 'Dental', 't1'),
        cat('c2', 'dental', 't2'),
        cat('c3', 'dental', 't3'),
      ],
    });
    const [only] = await service.listCategories();
    expect(only.name).toBe('dental');
  });

  it('keeps an Arabic-only category (the slug is Unicode-aware, not ASCII-only)', async () => {
    const { service } = buildIndex({
      categories: [cat('c1', 'طب الأسنان', 't1')],
    });
    const [only] = await service.listCategories();
    expect(only.name).toBe('طب الأسنان');
    expect(only.slug).toBe('طب-الأسنان');
  });

  it('drops a category whose name has no letters or digits — it has no public identity', async () => {
    const { service } = buildIndex({
      categories: [cat('c1', '---', 't1'), cat('c2', 'ECG', 't1')],
    });
    const result = await service.listCategories();
    expect(result.map((c) => c.slug)).toEqual(['ecg']);
  });

  it('visibility predicate: eligible clinic, active + non-deleted category and service, branch actually offers it', async () => {
    const { service, query } = buildIndex({});
    await service.listCategories();
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/t\.is_active = true/);
    expect(sql).toMatch(/t\.deleted_at IS NULL/);
    expect(sql).toMatch(/COALESCE\(ts\.public_booking_enabled, false\) = true/);
    expect(sql).toMatch(/sc\.is_active = true/);
    expect(sql).toMatch(/sc\.deleted_at IS NULL/);
    expect(sql).toMatch(/s\.is_active = true/);
    expect(sql).toMatch(/s\.deleted_at IS NULL/);
    expect(sql).toMatch(/b\.is_active = true/);
    expect(sql).toMatch(/b\.deleted_at IS NULL/);
    expect(sql).toMatch(/sp\.id IS NOT NULL/);
    expect(sql).toMatch(/s\."tenantId" = t\.id/);
  });

  it('the sample-services query applies the same visibility predicate', async () => {
    const { service, query } = buildIndex({
      categories: [cat('c1', 'Dental', 't1')],
    });
    await service.listCategories();
    const sql = query.mock.calls[1][0] as string;
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/sc\.deleted_at IS NULL/);
    expect(sql).toMatch(/s\.deleted_at IS NULL/);
    expect(sql).toMatch(/b\.deleted_at IS NULL/);
    expect(sql).toMatch(/LIMIT 3/);
  });

  it('returns [] without a second query when nothing is eligible', async () => {
    const { service, query } = buildIndex({});
    await expect(service.listCategories()).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('samples one service per clinic first, then fills, never more than three', async () => {
    const { service } = buildIndex({
      categories: [cat('c1', 'Dental', 't1', 3), cat('c2', 'Dental', 't2', 2)],
      samples: [
        {
          category_id: 'c1',
          public_slug: 'a',
          name: 'Aligners',
          clinic_name: 'Noor',
          clinic_slug: 'noor',
        },
        {
          category_id: 'c1',
          public_slug: 'b',
          name: 'Braces',
          clinic_name: 'Noor',
          clinic_slug: 'noor',
        },
        {
          category_id: 'c2',
          public_slug: 'c',
          name: 'Cleaning',
          clinic_name: 'Amal',
          clinic_slug: 'amal',
        },
        {
          category_id: 'c2',
          public_slug: 'd',
          name: 'Dentures',
          clinic_name: 'Amal',
          clinic_slug: 'amal',
        },
      ],
    });
    const [only] = await service.listCategories();
    expect(only.services).toHaveLength(3);
    // Aligners (Noor) and Cleaning (Amal) come first — one per clinic — then Braces.
    expect(only.services.map((s) => s.slug)).toEqual(['a', 'c', 'b']);
    expect(only.services[0]).toEqual({
      slug: 'a',
      name: 'Aligners',
      clinic: { name: 'Noor', slug: 'noor' },
    });
  });

  it('caps the index at 60 categories, busiest first', async () => {
    const categories = Array.from({ length: 70 }, (_, i) =>
      cat(`c${i}`, `Category ${i}`, `t${i}`, 1),
    );
    // The last one is offered by two clinics, so it must lead.
    categories.push(cat('cx', 'Category 69', 'tx', 1));
    const { service } = buildIndex({ categories });
    const result = await service.listCategories();
    expect(result).toHaveLength(60);
    expect(result[0].slug).toBe('category-69');
    expect(result[0].clinicCount).toBe(2);
  });
});

describe('PublicDiscoveryService.searchServices — categorySlug (C13)', () => {
  function buildSearch(categoryRows: { id: string; name: string }[]) {
    const query = jest.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('FROM service_categories sc')) return categoryRows;
      if (/SELECT COUNT\(\*\)::int AS total/.test(sql)) return [{ total: 0 }];
      return [];
    });
    const service = new PublicDiscoveryService({ query } as never, {} as never);
    return { service, query };
  }

  it('resolves the slug to category ids and constrains the services query by them', async () => {
    const { service, query } = buildSearch([
      { id: 'c1', name: 'Dental' },
      { id: 'c2', name: ' dental ' },
      { id: 'c3', name: 'Laser' },
    ]);
    await service.searchServices({ categorySlug: 'dental' });
    const main = query.mock.calls.find(
      (c) =>
        (c[0] as string).includes('FROM services s') &&
        !(c[0] as string).includes('COUNT(*)'),
    )!;
    expect(main[0]).toMatch(/s\."categoryId" = ANY\(\$6::uuid\[\]\)/);
    expect(main[1][5]).toEqual(['c1', 'c2']);
    const count = query.mock.calls.find((c) =>
      (c[0] as string).includes('COUNT(*)'),
    )!;
    expect(count[1][3]).toEqual(['c1', 'c2']);
  });

  it('the category lookup itself applies the clinic eligibility and active/non-deleted predicate', async () => {
    const { service, query } = buildSearch([{ id: 'c1', name: 'Dental' }]);
    await service.searchServices({ categorySlug: 'dental' });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/t\.approval_status = 'APPROVED'/);
    expect(sql).toMatch(/sc\.is_active = true/);
    expect(sql).toMatch(/sc\.deleted_at IS NULL/);
  });

  it('an unknown category is an empty page — never the unfiltered listing — and runs no services query', async () => {
    const { service, query } = buildSearch([{ id: 'c1', name: 'Dental' }]);
    const result = await service.searchServices({
      categorySlug: 'does-not-exist',
    });
    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 24 });
    expect(query).toHaveBeenCalledTimes(1); // only the category lookup
  });

  it('a punctuation-only slug matches nothing', async () => {
    const { service, query } = buildSearch([{ id: 'c1', name: 'Dental' }]);
    const result = await service.searchServices({ categorySlug: '---' });
    expect(result.items).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('no category filter: no lookup, null id array', async () => {
    const { service, query } = buildSearch([]);
    await service.searchServices({ categorySlug: '   ' });
    const main = query.mock.calls.find(
      (c) =>
        (c[0] as string).includes('FROM services s') &&
        !(c[0] as string).includes('COUNT(*)'),
    )!;
    expect(main[1][5]).toBeNull();
    expect(
      query.mock.calls.some((c) =>
        (c[0] as string).includes('FROM service_categories sc'),
      ),
    ).toBe(false);
  });
});
