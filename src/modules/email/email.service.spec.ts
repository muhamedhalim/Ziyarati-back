import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';

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
    // Hashed — the raw token must never become a job id / log line / DB key.
    expect(job.idempotencyKey).toBe(
      'reset:' + createHash('sha256').update('tok-123').digest('hex'),
    );
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

  it("sendStaffCredentials keys on the new user's own row id — a recreated account can be re-notified", async () => {
    await service.sendStaffCredentials({
      to: 'staff@clinic.com',
      temporaryPassword: 'temp-pass-1',
      loginUrl: 'https://app.test/auth/login',
      tenantId: 't1',
      userId: 'user-original',
    });
    await service.sendStaffCredentials({
      to: 'staff@clinic.com',
      temporaryPassword: 'temp-pass-2',
      loginUrl: 'https://app.test/auth/login',
      tenantId: 't1',
      userId: 'user-recreated',
    });

    const [first, second] = queue.enqueueEmail.mock.calls.map(
      (c) => c[0].idempotencyKey,
    );
    expect(first).toBe('staff-credentials:user-original');
    expect(second).toBe('staff-credentials:user-recreated');
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

describe('EmailService — credential tokens never leak into job ids, logs or email_logs', () => {
  const RAW = 'a'.repeat(64);
  let queue: { enqueueEmail: jest.Mock };
  let service: EmailService;

  beforeEach(() => {
    queue = { enqueueEmail: jest.fn().mockResolvedValue(undefined) };
    service = new EmailService(
      queue as unknown as QueueService,
      { deliver: jest.fn() } as unknown as EmailDeliveryService,
      { get: jest.fn(() => undefined) } as never,
    );
  });

  it.each([
    [
      'invite',
      (s: EmailService) =>
        s.sendInvitation({ to: 'x@y.co', invitationUrl: 'u', token: RAW }),
    ],
    [
      'reset',
      (s: EmailService) =>
        s.sendPasswordReset({ to: 'x@y.co', resetUrl: 'u', token: RAW }),
    ],
    [
      'verify',
      (s: EmailService) =>
        s.sendVerification({ to: 'x@y.co', verifyUrl: 'u', token: RAW }),
    ],
  ])(
    '%s key is a SHA-256 of the token, stable across calls',
    async (prefix, send) => {
      await send(service);
      await send(service);
      const [k1, k2] = queue.enqueueEmail.mock.calls.map(
        (c) => c[0].idempotencyKey,
      );
      expect(k1).toBe(
        `${prefix}:${createHash('sha256').update(RAW).digest('hex')}`,
      );
      expect(k1).not.toContain(RAW);
      expect(k2).toBe(k1);
    },
  );

  it.each([
    [
      'invite',
      (s: EmailService) =>
        s.sendInvitation({
          to: 'x@y.co',
          invitationUrl: `https://a/reset?token=${RAW}`,
          token: RAW,
        }),
    ],
    [
      'reset',
      (s: EmailService) =>
        s.sendPasswordReset({
          to: 'x@y.co',
          resetUrl: `https://a/reset?token=${RAW}`,
          token: RAW,
        }),
    ],
    [
      'verify',
      (s: EmailService) =>
        s.sendVerification({
          to: 'x@y.co',
          verifyUrl: `https://a/verify?token=${RAW}`,
          token: RAW,
        }),
    ],
  ])(
    '%s job data carries the link but NOT a separate raw token field',
    async (_p, send) => {
      await send(service);
      const job = queue.enqueueEmail.mock.calls[0][0];
      expect(job.variables).not.toHaveProperty('token');
      // Only the link (needed to render the email) may still carry it — once.
      expect(JSON.stringify(job).split(RAW).length - 1).toBe(1);
    },
  );

  it('a dispatch failure is logged without the recipient address', async () => {
    const err = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    queue.enqueueEmail.mockRejectedValueOnce(new Error('redis down'));

    await service.sendInvitation({
      to: 'secret.person@clinic.com',
      invitationUrl: 'u',
      token: RAW,
      tenantId: 't1',
    });

    const line = String(err.mock.calls[0][0]);
    expect(line).toContain('redis down');
    expect(line).not.toContain('secret.person@clinic.com');
    expect(line).not.toContain(RAW);
    err.mockRestore();
  });
});
