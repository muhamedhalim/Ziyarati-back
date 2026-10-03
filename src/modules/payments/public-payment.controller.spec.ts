import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { PublicPaymentController } from './public-payment.controller';
import { TapOnboardingCallbackController } from './tap-onboarding-callback.controller';
import { ConfirmPublicReturnDto } from './dto/confirm-public-return.dto';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const reflector = new Reflector();
const proto = PublicPaymentController.prototype;

/**
 * The patient pay surface has no login, so its safety is structural. These
 * tests pin that structure — a refactor that quietly widened a route (took a
 * body, dropped the throttle, lost @Public and became unreachable, or grew a
 * money input) must fail here, not in production.
 */
describe('PublicPaymentController — structural guarantees', () => {
  const routes = ['resolve', 'checkout', 'confirmReturn'] as const;

  it.each(routes)('%s is @Public() (the payer has no account)', (m) => {
    expect(reflector.get(IS_PUBLIC_KEY, proto[m])).toBe(true);
  });

  it.each(routes)(
    '%s carries its own throttle (the platform default is far too loose here)',
    (m) => {
      // jest runs with NODE_ENV=test, which lifts the numeric ceiling; the
      // metadata's mere presence is what proves the route is individually limited.
      const limit = Reflect.getMetadata(`${THROTTLER_LIMIT}default`, proto[m]);
      expect(limit).toBeDefined();
    },
  );

  it('exposes exactly three routes under /public/payments', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PublicPaymentController)).toBe(
      'public/payments',
    );
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    );
    expect(handlers.sort()).toEqual(['checkout', 'confirmReturn', 'resolve']);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.resolve)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, proto.checkout)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(METHOD_METADATA, proto.confirmReturn)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.resolve)).toBe(
      'links/:token',
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.checkout)).toBe(
      'links/:token/checkout',
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.confirmReturn)).toBe(
      'return',
    );
  });

  it('checkout takes NO request body — the price, clinic and merchant are all derived server-side', () => {
    const paramTypes = Reflect.getMetadata(
      'design:paramtypes',
      proto,
      'checkout',
    );
    expect(paramTypes).toEqual([String]); // the token, nothing else
    // no @Body() parameter was registered on the handler
    const args =
      Reflect.getMetadata(
        '__routeArguments__',
        PublicPaymentController,
        'checkout',
      ) ?? {};
    expect(
      Object.keys(args).filter(
        (k) => k.startsWith('3:') /* RouteParamtypes.BODY */,
      ),
    ).toEqual([]);
  });

  it("the return endpoint's ONLY input is a charge id", async () => {
    const ok = plainToInstance(ConfirmPublicReturnDto, {
      chargeId: 'chg_TS05A4120230736x9K22710693',
    });
    expect(await validate(ok)).toHaveLength(0);
    for (const chargeId of [
      '',
      'abc',
      'chg_',
      'chg_ a',
      'chg_../x',
      'x'.repeat(200),
      123,
      undefined,
    ]) {
      const bad = plainToInstance(ConfirmPublicReturnDto, { chargeId });
      expect((await validate(bad)).length).toBeGreaterThan(0);
    }
    expect(Object.keys(new ConfirmPublicReturnDto())).toEqual(['chargeId']); // no other declared field
  });

  it('delegates to the service with the raw token / charge id and returns its answer verbatim', async () => {
    const svc = {
      resolve: jest.fn(async () => ({ state: 'payable' })),
      checkout: jest.fn(async () => ({
        state: 'redirect',
        redirectUrl: 'https://x.test',
      })),
      confirmReturn: jest.fn(async () => ({ state: 'paid' })),
    };
    const c = new PublicPaymentController(svc as never);
    expect(await c.resolve('tok')).toEqual({ state: 'payable' });
    expect(await c.checkout('tok')).toEqual({
      state: 'redirect',
      redirectUrl: 'https://x.test',
    });
    expect(await c.confirmReturn({ chargeId: 'chg_abcdef' })).toEqual({
      state: 'paid',
    });
    expect(svc.resolve).toHaveBeenCalledWith('tok');
    expect(svc.checkout).toHaveBeenCalledWith('tok');
    expect(svc.confirmReturn).toHaveBeenCalledWith('chg_abcdef');
  });
});

describe('TapOnboardingCallbackController', () => {
  const handler = TapOnboardingCallbackController.prototype.receive;

  it('is @Public() and individually throttled', () => {
    expect(reflector.get(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(
      Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler),
    ).toBeDefined();
  });

  it('lives under the Tap webhook path, one segment deeper than the signed charge webhook', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, TapOnboardingCallbackController),
    ).toBe('payments/webhooks/tap/onboarding');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':token');
  });

  it('answers the same 200 for every token — valid, stale, malformed or unknown', async () => {
    const onboarding = { recordCallback: jest.fn(async () => undefined) };
    const c = new TapOnboardingCallbackController(onboarding as never);
    for (const token of ['A'.repeat(43), 'stale', '']) {
      expect(await c.receive(token, { id: 'x' })).toEqual({ received: true });
    }
    expect(onboarding.recordCallback).toHaveBeenCalledTimes(3);
  });

  it('a persistence failure is swallowed (never a 5xx that logs the body) and logs only the error text', async () => {
    const onboarding = {
      recordCallback: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    };
    const c = new TapOnboardingCallbackController(onboarding as never);
    const logged: string[] = [];
    jest.spyOn((c as any).logger, 'error').mockImplementation((m: unknown) => {
      logged.push(String(m));
    });
    const out = await c.receive('A'.repeat(43), {
      merchant: { secret: 'sk_live_LEAK_ME' },
    });
    expect(out).toEqual({ received: true });
    expect(logged.join()).toContain('connection reset');
    expect(logged.join()).not.toContain('sk_live_LEAK_ME');
  });
});
