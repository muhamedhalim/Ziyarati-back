import { BranchCityService } from './branch-city.service';

describe('BranchCityService', () => {
  let query: jest.Mock;
  let service: BranchCityService;

  beforeEach(() => {
    query = jest.fn();
    const manager = { query };
    service = new BranchCityService({
      transaction: (fn: (m: unknown) => unknown) => fn(manager),
      query,
    } as never);
  });

  it('normalizes whitespace', () => {
    expect(BranchCityService.normalize('  Nasr   City ')).toBe('Nasr City');
  });

  it('reuses an existing city matched case-insensitively on name_en', async () => {
    query
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([{ id: 'c-riyadh' }]);
    await expect(service.resolveByName('riyadh')).resolves.toBe('c-riyadh');
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('LOWER(name_en) = LOWER($1)');
    expect(params).toEqual(['riyadh']);
    expect(query).toHaveBeenCalledTimes(2); // no INSERT
  });

  it('stores Arabic-script names in name_ar', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c-new' }]);
    await expect(service.resolveByName('  الرياض ', 4)).resolves.toBe('c-new');
    expect(query.mock.calls[1][0]).toContain('LOWER(name_ar)');
    const [insertSql, insertParams] = query.mock.calls[2];
    expect(insertSql).toContain('INSERT INTO cities (name_ar,');
    expect(insertParams).toEqual(['الرياض', 4]);
  });

  it('creates an unknown Latin name in name_en with a null country when none is known', async () => {
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'c-nasr' }]);
    await expect(service.resolveByName('Nasr  City')).resolves.toBe('c-nasr');
    expect(query.mock.calls[2][0]).toContain('INSERT INTO cities (name_en,');
    expect(query.mock.calls[2][1]).toEqual(['Nasr City', null]);
  });

  it('serialises concurrent creators of the same name with an advisory lock', async () => {
    query.mockResolvedValue([{ id: 'x' }]);
    await service.resolveByName('Jeddah');
    expect(query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(query.mock.calls[0][1]).toEqual(['cities:jeddah']);
  });

  it('loadByIds skips the query for an empty id list and dedupes otherwise', async () => {
    await expect(service.loadByIds(['', ''])).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValueOnce([{ id: 'a', name_ar: null, name_en: 'A' }]);
    const m = await service.loadByIds(['a', 'a']);
    expect(query.mock.calls[0][1]).toEqual([['a']]);
    expect(m.get('a')?.name_en).toBe('A');
  });
});
