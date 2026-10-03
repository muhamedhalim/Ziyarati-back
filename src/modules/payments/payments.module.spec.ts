import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { PATH_METADATA } from '@nestjs/common/constants';

import { PaymentsModule } from './payments.module';
import { PaymentController } from './payment.controller';
import { MerchantAccountController } from './merchant-account.controller';
import { PublicPaymentController } from './public-payment.controller';
import { TapOnboardingCallbackController } from './tap-onboarding-callback.controller';

const controllers: unknown[] = Reflect.getMetadata(
  MODULE_METADATA.CONTROLLERS,
  PaymentsModule,
);
const indexOf = (c: unknown) => controllers.indexOf(c);

describe('PaymentsModule — route registration order', () => {
  it('registers MerchantAccountController BEFORE PaymentController: `GET /payments/:id` would otherwise capture `GET /payments/merchant-account` and answer 400 (regression found by the Phase 4 e2e)', () => {
    expect(indexOf(MerchantAccountController)).toBeGreaterThanOrEqual(0);
    expect(indexOf(PaymentController)).toBeGreaterThanOrEqual(0);
    expect(indexOf(MerchantAccountController)).toBeLessThan(
      indexOf(PaymentController),
    );
  });

  it('the two controllers do share the /payments prefix (so the order really matters)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PaymentController)).toBe(
      'payments',
    );
    expect(Reflect.getMetadata(PATH_METADATA, MerchantAccountController)).toBe(
      'payments/merchant-account',
    );
  });

  it('mounts the Phase 4 public surfaces', () => {
    expect(indexOf(PublicPaymentController)).toBeGreaterThanOrEqual(0);
    expect(indexOf(TapOnboardingCallbackController)).toBeGreaterThanOrEqual(0);
  });
});
