import { EmailService } from './email.service';
import { QueueService } from '../../queue/queue.service';
import { EmailDeliveryService } from './email-delivery.service';

describe('EmailService — fallback idempotencyKey (gap-closure pass, §0.8.11)', () => {
  let queue: { enqueueEmail: jest.Mock };
  let delivery: { deliver: jest.Mock };
  let config: { get: jest.Mock };
  let service: EmailService;

  beforeEach(() => {
    queue = { enqueueEmail: jest.fn().mockResolvedValue(undefined) };
    delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
    config = { get: jest.fn(() => undefined) };
    service = new EmailService(
      queue as unknown as QueueService,
      delivery as unknown as EmailDeliveryService,
      config as never,
    );
  });

  it('assigns a deterministic key when the caller supplies none (sendDoctorNotification omits one)', async () => {
    await service.sendDoctorNotification({
      to: 'doc@x.com',
      title: 'Hi',
      message: 'You have a new patient',
      tenantId: 't1',
    });

    const job = queue.enqueueEmail.mock.calls[0][0];
    expect(job.idempotencyKey).toEqual(
      expect.stringMatching(/^auto:[a-f0-9]{64}$/),
    );
  });

  it('the SAME call produces the SAME key twice (redelivery-safe)', async () => {
    const call = () =>
      service.sendPatientNotification({
        to: 'p@x.com',
        title: 'Reminder',
        message: 'Your appointment is tomorrow',
        tenantId: 't1',
      });
    await call();
    await call();

    const [first, second] = queue.enqueueEmail.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(first).toBe(second);
  });

  it('a DIFFERENT message to the same recipient/template gets a DIFFERENT key — must not collapse two real sends into one', async () => {
    await service.sendSecurityAlert({
      to: 'admin@x.com',
      message: 'Login from new device',
      tenantId: 't1',
    });
    await service.sendSecurityAlert({
      to: 'admin@x.com',
      message: 'Password changed',
      tenantId: 't1',
    });

    const [first, second] = queue.enqueueEmail.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(first).not.toBe(second);
  });

  it('never overrides an explicit idempotencyKey the caller already supplies', async () => {
    await service.sendPasswordReset({
      to: 'u@x.com',
      resetUrl: 'https://x/reset',
      tenantId: 't1',
      token: 'tok-123',
    });

    const job = queue.enqueueEmail.mock.calls[0][0];
    expect(job.idempotencyKey).toBe('reset:tok-123');
  });

  it("sendWelcome keys on the new user's own row id, not on to+tenantId (L4) — a recreated account with a new userId can get a second welcome email", async () => {
    await service.sendWelcome({
      to: 'owner@x.com',
      tenantId: 't1',
      userId: 'user-original',
    });
    await service.sendWelcome({
      to: 'owner@x.com',
      tenantId: 't1',
      userId: 'user-recreated',
    });

    const [first, second] = queue.enqueueEmail.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(first).toBe('welcome:user-original');
    expect(second).toBe('welcome:user-recreated');
    expect(first).not.toBe(second);
  });

  it('a caller of sendDoctorNotification with a business-process key (e.g. UsageReportService) bypasses the content hash entirely — two calls with IDENTICAL content but DIFFERENT keys both send', async () => {
    await service.sendDoctorNotification({
      to: 'admin@x.com',
      title: 'Report',
      message: 'identical digest text',
      idempotencyKey: 'usage-report:sched-1:2026-06-01T00:00:00.000Z',
    });
    await service.sendDoctorNotification({
      to: 'admin@x.com',
      title: 'Report',
      message: 'identical digest text',
      idempotencyKey: 'usage-report:sched-1:2026-07-01T00:00:00.000Z',
    });

    const [first, second] = queue.enqueueEmail.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(first).toBe('usage-report:sched-1:2026-06-01T00:00:00.000Z');
    expect(second).toBe('usage-report:sched-1:2026-07-01T00:00:00.000Z');
    expect(first).not.toBe(second);
  });
});
