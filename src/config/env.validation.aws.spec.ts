import { validate } from './env.validation';

/**
 * AWS keys (Amazon SES email, STORAGE_PROVIDER=s3). Kept separate
 * from env.validation.spec.ts, which carries known pre-existing failures
 * (see project notes), so these results stand on their own.
 *
 * The baseline mirrors what the ECS task definition + Secrets Manager inject
 * in production (infra/terraform/modules/platform/main.tf).
 */
const awsProduction = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://ziyarati_app:pw@zt-production-pg.x.me-central-1.rds.amazonaws.com:5432/ziyarati',
  REDIS_URL: 'rediss://:token@master.zt-production-valkey.x.mec1.cache.amazonaws.com:6379/0',
  JWT_ACCESS_SECRET: 'a'.repeat(64),
  JWT_REFRESH_SECRET: 'b'.repeat(64),
  CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  FRONTEND_ORIGIN: 'https://www.ziyaratech.com',
  DB_SSL_CA: '/app/certs/rds-global-bundle.pem',
  AUTH_REGISTER_OWNER_ENDPOINT_CEILING: 1000,
  PAYMENT_PROVIDER: 'noop',
  ALLOW_PAYMENT_SIMULATOR_IN_PRODUCTION: 'true',
  AWS_REGION: 'me-central-1',
  SES_CONFIGURATION_SET: 'zt-production',
  EMAIL_FROM: 'no-reply@ziyaratech.com',
  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'zt-production-uploads-123456789012',
  REDIS_MEMORY_CONFIG_VERIFIED_VIA_IAC: 'true',
};

describe('env.validation — AWS migration (SES / S3)', () => {
  it('accepts the production environment the ECS task definition provides — no email provider keys needed', () => {
    const value = validate({ ...awsProduction });
    expect(value.STORAGE_PROVIDER).toBe('s3');
  });

  it('rejects the removed r2 storage provider', () => {
    expect(() => validate({ ...awsProduction, STORAGE_PROVIDER: 'r2' })).toThrow(
      /Env validation error/,
    );
  });

  it('rejects any EMAIL_PROVIDER other than ses — there is no provider choice any more', () => {
    expect(() => validate({ ...awsProduction, EMAIL_PROVIDER: 'sendgrid' })).toThrow(
      /EMAIL_PROVIDER=sendgrid/,
    );
    expect(() => validate({ ...awsProduction, EMAIL_PROVIDER: 'resend' })).toThrow(
      /EMAIL_PROVIDER=resend/,
    );
    expect(() => validate({ ...awsProduction, EMAIL_PROVIDER: 'ses' })).not.toThrow();
  });

  it('refuses to boot with SES and no region', () => {
    const { AWS_REGION: _omit, STORAGE_PROVIDER: _storage, ...rest } = awsProduction;
    expect(() => validate(rest)).toThrow(
      /Amazon SES.*SES_REGION or AWS_REGION/s,
    );
  });

  it('accepts SES_REGION in place of AWS_REGION', () => {
    const { AWS_REGION: _omit, ...rest } = awsProduction;
    expect(() =>
      validate({ ...rest, SES_REGION: 'me-central-1', S3_REGION: 'me-central-1' }),
    ).not.toThrow();
  });

  it('refuses to boot with SES and a malformed sender (same sender rule)', () => {
    expect(() => validate({ ...awsProduction, EMAIL_FROM: '' })).toThrow(/EMAIL_FROM/);
  });

  it('refuses a leftover RESEND_API_KEY instead of silently carrying the secret', () => {
    expect(() => validate({ ...awsProduction, RESEND_API_KEY: 're_x' })).toThrow(
      /RESEND_API_KEY.*retired email provider/s,
    );
    expect(() => validate({ ...awsProduction, RESEND_API_KEY: '' })).not.toThrow();
  });

  it('refuses to boot with STORAGE_PROVIDER=s3 and no bucket', () => {
    expect(() => validate({ ...awsProduction, S3_BUCKET: '' })).toThrow(
      /STORAGE_PROVIDER=s3 in production requires S3_BUCKET/,
    );
  });

  it('does not enforce S3 settings outside production', () => {
    expect(() =>
      validate({ ...awsProduction, NODE_ENV: 'development', S3_BUCKET: '' }),
    ).not.toThrow();
  });

  it('rejects a non-URL SES feedback queue', () => {
    expect(() => validate({ ...awsProduction, SES_FEEDBACK_QUEUE_URL: 'not a url' })).toThrow(
      /Env validation error/,
    );
  });
});
