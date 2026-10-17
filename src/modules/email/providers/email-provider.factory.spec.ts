import {
  EmailConfigurationError,
  EmailProviderFactory,
} from './email-provider.factory';
import { NoopEmailProvider } from './noop-email.provider';
import { SesProvider } from './ses.provider';

const build = (env: Record<string, string | undefined>) => {
  const config = { get: jest.fn((k: string) => env[k]) } as never;
  return new EmailProviderFactory(
    config,
    new NoopEmailProvider(),
    new SesProvider(config),
  );
};

describe('EmailProviderFactory — Amazon SES is the only provider', () => {
  it('email disabled → the no-op provider (development/test default)', () => {
    const f = build({ NODE_ENV: 'development' });
    expect(f.resolve().name).toBe('noop');
    expect(f.isLiveDelivery()).toBe(false);
  });

  it('enabled + SES region → SES', () => {
    const f = build({ EMAIL_ENABLED: 'true', AWS_REGION: 'eu-central-1' });
    expect(f.resolve().name).toBe('ses');
    expect(f.isLiveDelivery()).toBe(true);
  });

  it('enabled without a region throws a configuration error — it never downgrades to no-op', () => {
    const f = build({ EMAIL_ENABLED: 'true' });
    expect(() => f.resolve()).toThrow(EmailConfigurationError);
    expect(() => f.resolve()).toThrow(/SES_REGION/);
    expect(f.isLiveDelivery()).toBe(false);
  });

  it('a leftover RESEND_API_KEY / EMAIL_PROVIDER=resend is ignored — nothing can select another provider', () => {
    const f = build({
      EMAIL_ENABLED: 'true',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_x',
    });
    expect(() => f.resolve()).toThrow(EmailConfigurationError);
  });

  it('the error message names settings only, never values', () => {
    const f = build({ EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_SECRET' });
    try {
      f.resolve();
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('re_SECRET');
    }
  });
});
