import { UnrecoverableError } from 'bullmq';

import { validateJobPayload } from './job-payload-validator';
import { JOB } from './queue.constants';

describe('validateJobPayload', () => {
  it('is a no-op for a job name with no registered required fields', () => {
    expect(() =>
      validateJobPayload('some.unregistered.job', { tenantId: 't1' }),
    ).not.toThrow();
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_REAP, { tenantId: null }),
    ).not.toThrow();
  });

  it('throws when the payload is not a plain object', () => {
    expect(() => validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, null)).toThrow(
      UnrecoverableError,
    );
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, 'a string'),
    ).toThrow(UnrecoverableError);
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, ['array']),
    ).toThrow(UnrecoverableError);
  });

  it('passes a well-formed notifications.dispatch payload', () => {
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        notificationId: 'n1',
      }),
    ).not.toThrow();
  });

  it('rejects notifications.dispatch missing notificationId', () => {
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, { tenantId: 't1' }),
    ).toThrow(/notificationId/);
  });

  it('rejects notifications.dispatch with an empty-string notificationId', () => {
    expect(() =>
      validateJobPayload(JOB.NOTIFICATIONS_DISPATCH, {
        tenantId: 't1',
        notificationId: '',
      }),
    ).toThrow(UnrecoverableError);
  });

  it('rejects ai.execute missing any of its three required string fields', () => {
    expect(() =>
      validateJobPayload(JOB.AI_EXECUTE, {
        tenantId: 't1',
        aiConversationId: 'c1',
        content: 'hi',
        // idempotencyKey missing
      }),
    ).toThrow(/idempotencyKey/);
  });

  it('validates both a string and a numeric required field for workflow.action', () => {
    expect(() =>
      validateJobPayload(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        runId: 'r1',
        actionIndex: 0,
      }),
    ).not.toThrow();
    expect(() =>
      validateJobPayload(JOB.WORKFLOW_ACTION, { tenantId: 't1', runId: 'r1' }),
    ).toThrow(/actionIndex/);
    expect(() =>
      validateJobPayload(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        runId: 'r1',
        actionIndex: 'zero',
      }),
    ).toThrow(/actionIndex/);
  });

  it('accepts actionIndex: 0 as valid (falsy but a real value) — regression guard against a truthiness check', () => {
    expect(() =>
      validateJobPayload(JOB.WORKFLOW_ACTION, {
        tenantId: 't1',
        runId: 'r1',
        actionIndex: 0,
      }),
    ).not.toThrow();
  });

  it('validates all four required fields for whatsapp.mediaDownload', () => {
    const valid = {
      tenantId: 't1',
      accountId: 'a',
      messageId: 'm',
      mediaId: 'md',
      mediaType: 'image',
    };
    expect(() =>
      validateJobPayload(JOB.WHATSAPP_MEDIA_DOWNLOAD, valid),
    ).not.toThrow();
    for (const field of ['accountId', 'messageId', 'mediaId', 'mediaType']) {
      const { [field]: _removed, ...rest } = valid as Record<string, unknown>;
      expect(() =>
        validateJobPayload(JOB.WHATSAPP_MEDIA_DOWNLOAD, rest),
      ).toThrow(UnrecoverableError);
    }
  });

  it('requires tenantId, paymentId and outcome for payments.outcome (REL-005)', () => {
    const valid = { tenantId: 't1', paymentId: 'p1', outcome: 'paid' };
    expect(() => validateJobPayload(JOB.PAYMENTS_OUTCOME, valid)).not.toThrow();
    for (const field of ['tenantId', 'paymentId', 'outcome']) {
      const { [field]: _removed, ...rest } = valid as Record<string, unknown>;
      expect(() => validateJobPayload(JOB.PAYMENTS_OUTCOME, rest)).toThrow(
        UnrecoverableError,
      );
    }
  });
});
