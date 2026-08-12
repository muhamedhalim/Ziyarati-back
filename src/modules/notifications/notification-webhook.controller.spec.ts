import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'node:fs';

import { NotificationWebhookController } from './notification-webhook.controller';
import { createMockConfigService } from '../../../test/utils/mock-factories';

/**
 * O1 — behavioural and structural regression coverage for the deliberately
 * UNMOUNTED webhook verification controller (plan.md O1; research.md R9).
 * The class is absent from every module's `controllers` array (confirmed by
 * `test/security/nest-route-metadata.ts`'s `isControllerMounted()` — see
 * `config-invariants.spec.ts`, T045) but remains directly unit-testable,
 * which is exactly what this file does.
 */
describe('NotificationWebhookController.verify (O1 — unmounted, but tested)', () => {
  const buildController = (verifyToken: string | undefined) => {
    const config = createMockConfigService({ WHATSAPP_VERIFY_TOKEN: verifyToken });
    const delivery = {} as never;
    return new NotificationWebhookController(config as never, delivery);
  };

  it('rejects with 403 when the presented token does not match the configured one', () => {
    const controller = buildController('correct-token');
    expect(() => controller.verify('subscribe', 'wrong-token', 'the-challenge')).toThrow(
      ForbiddenException,
    );
  });

  it('echoes the challenge when the presented token matches the configured one', () => {
    const controller = buildController('correct-token');
    expect(controller.verify('subscribe', 'correct-token', 'the-challenge')).toBe(
      'the-challenge',
    );
  });

  it('rejects with 403 when hub.mode is not "subscribe", even with a correct token', () => {
    const controller = buildController('correct-token');
    expect(() => controller.verify('unsubscribe', 'correct-token', 'the-challenge')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects with 403 when the token is missing', () => {
    const controller = buildController('correct-token');
    expect(() => controller.verify('subscribe', undefined, 'the-challenge')).toThrow(
      ForbiddenException,
    );
  });

  it('rejects with 403 when no verify token is configured at all (fails closed)', () => {
    const controller = buildController(undefined);
    expect(() => controller.verify('subscribe', 'anything', 'the-challenge')).toThrow(
      ForbiddenException,
    );
  });

  it('[O1 structural] no direct equality comparison against the token or secret remains in this file — a single-file absence check, with no decorator-to-handler association step and no proximity heuristic (research.md R10; consistent with FR-032)', () => {
    const source = readFileSync(__dirname + '/notification-webhook.controller.ts', 'utf8');
    expect(source).not.toMatch(/\btoken\s*===\s*expected\b/);
    expect(source).not.toMatch(/\bexpected\s*===\s*token\b/);
    expect(source).toContain('constantTimeEqual(token, expected)');
  });
});
