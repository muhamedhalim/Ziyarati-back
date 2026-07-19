import { ConfigService } from '@nestjs/config';

import { MoyasarWebhookVerifier } from './moyasar-webhook.verifier';
import { PaymentsConfig } from '../payments.config';
import { createMockConfigService } from '../../../../test/utils/mock-factories';

describe('MoyasarWebhookVerifier', () => {
  const build = (overrides: Record<string, unknown>) =>
    new MoyasarWebhookVerifier(
      new PaymentsConfig(createMockConfigService(overrides) as unknown as ConfigService),
    );

  it('accepts a token matching the configured secret', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: 'shh' }).verify('shh')).toBe(true);
  });

  it('rejects a token that does not match the secret', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: 'shh' }).verify('nope')).toBe(false);
  });

  it('rejects a token of a different length (no timingSafeEqual throw)', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: 'shh' }).verify('longer-token')).toBe(false);
  });

  it('rejects a missing token even when a secret is configured', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: 'shh' }).verify(undefined)).toBe(false);
  });

  it('FAILS CLOSED in production when no secret is configured', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: '', NODE_ENV: 'production' }).verify('x')).toBe(false);
  });

  it('accepts (dev convenience) when no secret is configured outside production', () => {
    expect(build({ MOYASAR_WEBHOOK_SECRET: '', NODE_ENV: 'development' }).verify('x')).toBe(true);
  });
});
