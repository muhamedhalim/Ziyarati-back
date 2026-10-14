const queryRunner = {
  connect: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue(undefined),
  release: jest.fn().mockResolvedValue(undefined),
};

const dataSourceInstance = {
  initialize: jest.fn().mockResolvedValue(undefined),
  createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  runMigrations: jest.fn().mockResolvedValue([]),
  destroy: jest.fn().mockResolvedValue(undefined),
};

jest.mock('typeorm', () => ({
  DataSource: jest.fn().mockImplementation(() => dataSourceInstance),
  // SafeTypeOrmLogger (LSA-01) builds its dev-only echo delegate from this.
  AdvancedConsoleLogger: jest.fn().mockImplementation(() => ({})),
}));

import { DataSource } from 'typeorm';
import { runMigrationsWithAdvisoryLock } from './run-migrations-with-lock';

describe('runMigrationsWithAdvisoryLock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dataSourceInstance.initialize.mockResolvedValue(undefined);
    dataSourceInstance.createQueryRunner.mockReturnValue(queryRunner);
    dataSourceInstance.runMigrations.mockResolvedValue([]);
    dataSourceInstance.destroy.mockResolvedValue(undefined);
    queryRunner.connect.mockResolvedValue(undefined);
    queryRunner.query.mockResolvedValue(undefined);
    queryRunner.release.mockResolvedValue(undefined);
  });

  it('acquires the advisory lock, runs migrations, releases the lock, and tears down the dedicated DataSource', async () => {
    await runMigrationsWithAdvisoryLock('postgres://localhost/db', false);

    expect(DataSource).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'postgres',
        url: 'postgres://localhost/db',
      }),
    );
    expect(dataSourceInstance.initialize).toHaveBeenCalled();
    expect(queryRunner.connect).toHaveBeenCalled();

    const calls = queryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls[0]).toContain('pg_advisory_lock');
    expect(calls[calls.length - 1]).toContain('pg_advisory_unlock');

    expect(dataSourceInstance.runMigrations).toHaveBeenCalled();
    // lock acquired before migrations run, released after
    const lockCallIndex = calls.findIndex((c) =>
      c.includes('pg_advisory_lock'),
    );
    const unlockCallIndex = calls.findIndex((c) =>
      c.includes('pg_advisory_unlock'),
    );
    expect(lockCallIndex).toBeLessThan(unlockCallIndex);

    expect(queryRunner.release).toHaveBeenCalled();
    expect(dataSourceInstance.destroy).toHaveBeenCalled();
  });

  it('still releases the advisory lock and tears down the DataSource if runMigrations throws', async () => {
    dataSourceInstance.runMigrations.mockRejectedValueOnce(
      new Error('migration failed'),
    );

    await expect(
      runMigrationsWithAdvisoryLock('postgres://localhost/db', false),
    ).rejects.toThrow('migration failed');

    const calls = queryRunner.query.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => c.includes('pg_advisory_unlock'))).toBe(true);
    expect(queryRunner.release).toHaveBeenCalled();
    expect(dataSourceInstance.destroy).toHaveBeenCalled();
  });

  // ZT-012: the isProduction → ssl-options DECISION now lives entirely in
  // the single shared `databaseSslOptions()` helper (database-ssl.spec.ts) —
  // this function's own responsibility is just to pass whatever `ssl` value
  // its caller computed straight through to the DataSource it constructs,
  // unchanged, so the migration DataSource can never diverge from the
  // runtime one.
  it('passes the caller-supplied ssl value straight through, unchanged', async () => {
    await runMigrationsWithAdvisoryLock('postgres://localhost/db', {
      rejectUnauthorized: true,
      ca: 'test-ca-content',
    });
    expect(DataSource).toHaveBeenCalledWith(
      expect.objectContaining({
        ssl: { rejectUnauthorized: true, ca: 'test-ca-content' },
      }),
    );

    await runMigrationsWithAdvisoryLock('postgres://localhost/db', false);
    expect(DataSource).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: false }),
    );
  });
});
