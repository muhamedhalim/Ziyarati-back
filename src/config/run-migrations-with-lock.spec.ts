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

  it('passes ssl options only in production', async () => {
    await runMigrationsWithAdvisoryLock('postgres://localhost/db', true);
    expect(DataSource).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { rejectUnauthorized: false } }),
    );

    await runMigrationsWithAdvisoryLock('postgres://localhost/db', false);
    expect(DataSource).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: false }),
    );
  });
});
