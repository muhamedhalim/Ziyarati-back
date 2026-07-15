import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { QueryPermissionsDto } from './query-permissions.dto';

const errorsFor = (raw: Record<string, unknown>) =>
  validateSync(plainToInstance(QueryPermissionsDto, raw), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });

describe('QueryPermissionsDto', () => {
  it('applies defaults for an empty query', () => {
    const dto = plainToInstance(QueryPermissionsDto, {});
    expect(errorsFor({})).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(25);
    expect(dto.sortBy).toBe('module');
    expect(dto.sortDir).toBe('ASC');
    expect(dto.status).toBe('all');
    expect(dto.assignment).toBe('all');
    expect(dto.metadata).toBe('all');
  });

  it('accepts a fully-specified valid query', () => {
    expect(
      errorsFor({
        search: 'refund',
        module: 'payments',
        scope: 'tenant',
        risk: 'critical',
        status: 'deprecated',
        assignment: 'unassigned',
        metadata: 'missing_description',
        sortBy: 'effectiveUserCount',
        sortDir: 'DESC',
        page: '2',
        limit: '50',
      }),
    ).toHaveLength(0);
  });

  it('rejects a non-whitelisted sort column (no arbitrary ORDER BY)', () => {
    const errors = errorsFor({ sortBy: 'created_at; DROP TABLE permissions' });
    expect(errors.some((e) => e.property === 'sortBy')).toBe(true);
  });

  it('rejects an invalid risk level', () => {
    expect(errorsFor({ risk: 'catastrophic' }).some((e) => e.property === 'risk')).toBe(true);
  });

  it('rejects an invalid scope', () => {
    expect(errorsFor({ scope: 'galaxy' }).some((e) => e.property === 'scope')).toBe(true);
  });

  it('rejects an invalid assignment state', () => {
    expect(errorsFor({ assignment: 'maybe' }).some((e) => e.property === 'assignment')).toBe(true);
  });

  it('enforces pagination bounds', () => {
    expect(errorsFor({ page: '0' }).some((e) => e.property === 'page')).toBe(true);
    expect(errorsFor({ limit: '500' }).some((e) => e.property === 'limit')).toBe(true);
  });
});
