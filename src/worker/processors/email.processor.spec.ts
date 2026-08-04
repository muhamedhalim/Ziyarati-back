import { UnrecoverableError } from 'bullmq';

import { EmailProcessor } from './email.processor';
import { EmailDeliveryService } from '../../modules/email/email-delivery.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { JOB } from '../../queue/queue.constants';

/**
 * FND-036 — verified root cause (C3, research.md AD-04): `email.processor.ts`
 * is 36 lines calling `this.delivery.deliver(job.data)` directly — it never
 * calls `runInTenantContext`, `validateJobPayload`, or
 * `WorkerAuthorizationService`, unlike every sibling processor
 * (`notifications.processor.ts` is the reference). `JOB.EMAIL_SEND` already
 * has a registered authorization policy (`job-authorization.constants.ts:92`,
 * `SYSTEM_OR_TENANT`) that nothing consumes — so a tenant suspended AFTER an
 * email job was enqueued still has that email delivered.
 *
 * This is a plain unit test (`new EmailProcessor(...)`, not DI) — extra
 * constructor args beyond today's single `delivery` param are accepted at
 * runtime (isolatedModules — no arity check) but are simply never wired to
 * anything, which is exactly the defect: `authz`/`ctx` are inert today.
 *
 * T050: `job.data` below deliberately omits every optional `EmailSendJob`
 * field (`variables`, `locale`, `idempotencyKey`, `replyTo`, `correlationId`,
 * `v`) — `EmailSendJob` was not reshaped by Wave 2, so this doubles as proof
 * that a pre-deployment-shaped job still flows through the modified
 * processor without crashing (see the second test: it completes and calls
 * `delivery.deliver`, it does not throw).
 */
describe('EmailProcessor — suspended-tenant guard (FND-036)', () => {
  let delivery: { deliver: jest.Mock };
  let authz: { assertAuthorized: jest.Mock };
  let ctx: TenantContextService;
  let processor: EmailProcessor;

  const job = {
    name: JOB.EMAIL_SEND,
    data: { tenantId: 't1', to: 'patient@example.test', template: 'appointment-reminder' },
    attemptsMade: 0,
  } as any;

  beforeEach(() => {
    delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    ctx = new TenantContextService();
    authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
    processor = new EmailProcessor(
      delivery as unknown as EmailDeliveryService,
      ctx,
      authz as unknown as WorkerAuthorizationService,
    );
  });

  it('[FND-036] refuses to deliver a job whose tenant has been suspended since it was enqueued', async () => {
    authz.assertAuthorized.mockRejectedValueOnce(
      new UnrecoverableError('Tenant t1 is not active — job permanently rejected'),
    );

    await expect(processor.process(job)).rejects.toThrow();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('[FND-036] consults the existing JOB.EMAIL_SEND authorization policy before delivering (today it never does)', async () => {
    await processor.process(job);

    expect(authz.assertAuthorized).toHaveBeenCalledWith(JOB.EMAIL_SEND, job.data);
    expect(delivery.deliver).toHaveBeenCalledWith(job.data);
  });
});
