import { validate } from './env.validation';

const base = {
  DATABASE_URL: 'postgres://x',
  JWT_ACCESS_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
};

describe('env.validation', () => {
  it('accepts a minimal valid config and applies defaults', () => {
    const value = validate({ ...base });
    expect(value.NODE_ENV).toBe('development');
    expect(value.TYPEORM_SYNCHRONIZE).toBe('false');
    expect(value.QUEUE_DEFAULT_ATTEMPTS).toBe(5);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validate({ JWT_ACCESS_SECRET: 'secret' })).toThrow(/Env validation error/);
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    expect(() => validate({ DATABASE_URL: 'postgres://x', JWT_REFRESH_SECRET: 'r' })).toThrow(/Env validation error/);
  });

  it('throws when JWT_REFRESH_SECRET is missing', () => {
    expect(() => validate({ DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 's' })).toThrow(/Env validation error/);
  });

  it('rejects an invalid NODE_ENV enum', () => {
    expect(() => validate({ ...base, NODE_ENV: 'staging' })).toThrow(/Env validation error/);
  });

  it('rejects an invalid boolean-string flag', () => {
    expect(() => validate({ ...base, TYPEORM_SYNCHRONIZE: 'yes' })).toThrow(/Env validation error/);
  });

  it('floors ANALYTICS_EVENT_RETENTION_DAYS at 1', () => {
    expect(() => validate({ ...base, ANALYTICS_EVENT_RETENTION_DAYS: 0 })).toThrow();
  });

  it('allows unknown keys to pass through', () => {
    const value = validate({ ...base, SOME_OTHER_KEY: 'x' });
    expect(value.SOME_OTHER_KEY).toBe('x');
  });
});
