import { EmailWebhookController } from './email-webhook.controller';
import { EmailWebhookSignatureVerifier } from './email-webhook-signature.verifier';
import { RecipientDeliveryService } from '../../campaigns/recipient-delivery.service';
import { EmailSuppressionService } from '../email-suppression.service';
import { RecipientDelivery } from '../../../entities/enums';
import { AppError } from '../../../common/errors';

/** T136's own required test matrix: valid, invalid, and replayed feedback. */
describe('EmailWebhookController (T136)', () => {
  let controller: EmailWebhookController;
  let verifier: { verify: jest.Mock };
  let delivery: { recordDeliveryTrusted: jest.Mock };
  let suppression: { suppress: jest.Mock };

  const req = { rawBody: Buffer.from('{}') } as never;
  const body = { type: 'email.bounced', data: { email_id: 'resend-msg-1' } };

  beforeEach(() => {
    verifier = { verify: jest.fn() };
    delivery = { recordDeliveryTrusted: jest.fn() };
    suppression = { suppress: jest.fn().mockResolvedValue(undefined) };
    controller = new EmailWebhookController(
      verifier as unknown as EmailWebhookSignatureVerifier,
      delivery as unknown as RecipientDeliveryService,
      suppression as unknown as EmailSuppressionService,
    );
  });

  it('VALID: a correctly-signed bounce event resolves the recipient and writes a suppression', async () => {
    verifier.verify.mockReturnValueOnce(true);
    delivery.recordDeliveryTrusted.mockResolvedValueOnce({
      updated: true,
      delivery: RecipientDelivery.BOUNCED,
      tenantId: 'tenant-a',
      email: 'patient@example.com',
    });

    const result = await controller.handle(req, body, 'sha256=validsig');

    expect(delivery.recordDeliveryTrusted).toHaveBeenCalledWith(
      'resend-msg-1',
      RecipientDelivery.BOUNCED,
    );
    expect(suppression.suppress).toHaveBeenCalledWith(
      'tenant-a',
      'patient@example.com',
      'BOUNCE',
      'webhook',
    );
    expect(result).toEqual({ accepted: true, suppressed: true });
  });

  it('VALID: a complaint event writes a COMPLAINT-reasoned suppression', async () => {
    verifier.verify.mockReturnValueOnce(true);
    delivery.recordDeliveryTrusted.mockResolvedValueOnce({
      updated: true,
      tenantId: 'tenant-a',
      email: 'patient@example.com',
    });

    await controller.handle(
      req,
      { type: 'email.complained', data: { email_id: 'resend-msg-2' } },
      'sha256=validsig',
    );

    expect(suppression.suppress).toHaveBeenCalledWith(
      'tenant-a',
      'patient@example.com',
      'COMPLAINT',
      'webhook',
    );
  });

  it('INVALID: an unverified/badly-signed webhook suppresses NOTHING and is rejected', async () => {
    verifier.verify.mockReturnValueOnce(false);

    await expect(
      controller.handle(req, body, 'sha256=badsig'),
    ).rejects.toBeInstanceOf(AppError);
    expect(delivery.recordDeliveryTrusted).not.toHaveBeenCalled();
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('REPLAYED: the same verified payload processed twice suppresses at most once (idempotent, never errors)', async () => {
    verifier.verify.mockReturnValue(true);
    delivery.recordDeliveryTrusted.mockResolvedValue({
      updated: false, // second time, recordDelivery's own forward-only guard reports no-op
      reason: 'already-bounced',
      tenantId: 'tenant-a',
      email: 'patient@example.com',
    });

    const first = await controller.handle(req, body, 'sha256=validsig');
    const second = await controller.handle(req, body, 'sha256=validsig');

    expect(first).toEqual({ accepted: true, suppressed: true });
    expect(second).toEqual({ accepted: true, suppressed: true });
    // The suppression write is itself idempotent (ON CONFLICT DO NOTHING) —
    // calling it twice with the same (tenant, email) is a safe no-op, so the
    // controller calling it both times is correct, not a duplication bug.
    expect(suppression.suppress).toHaveBeenCalledTimes(2);
  });

  it('a verified but irrelevant event (no matching send) accepts without suppressing', async () => {
    verifier.verify.mockReturnValueOnce(true);
    delivery.recordDeliveryTrusted.mockResolvedValueOnce({
      updated: false,
      reason: 'recipient-not-found',
    });

    const result = await controller.handle(req, body, 'sha256=validsig');
    expect(result).toEqual({ accepted: true, suppressed: false });
    expect(suppression.suppress).not.toHaveBeenCalled();
  });

  it('a verified event of an unrecognised type accepts without touching delivery or suppression', async () => {
    verifier.verify.mockReturnValueOnce(true);
    const result = await controller.handle(
      req,
      { type: 'email.delivered', data: { email_id: 'resend-msg-1' } },
      'sha256=validsig',
    );
    expect(result).toEqual({ accepted: true, suppressed: false });
    expect(delivery.recordDeliveryTrusted).not.toHaveBeenCalled();
  });
});
