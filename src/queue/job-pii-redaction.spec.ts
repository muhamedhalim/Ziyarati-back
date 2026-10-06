import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  isMinimized,
  MINIMIZED_FLAG,
  minimizeCompletedJob,
  minimizeJobData,
} from './job-pii-redaction';
import { JOB } from './queue.constants';

describe('minimizeJobData', () => {
  it('drops recipient, variables and reply-to from a completed email job', () => {
    const out = minimizeJobData(JOB.EMAIL_SEND, {
      tenantId: 't1',
      correlationId: 'c1',
      to: 'sara@example.com',
      template: 'staff_credentials',
      variables: { name: 'Sara', temporaryPassword: 'Tmp#12345' },
      locale: 'ar',
      idempotencyKey: 'staff-credentials:u1',
      replyTo: 'clinic@example.com',
    })!;

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sara@example.com');
    expect(serialized).not.toContain('Tmp#12345');
    expect(serialized).not.toContain('clinic@example.com');
    expect(out).toMatchObject({
      tenantId: 't1',
      correlationId: 'c1',
      template: 'staff_credentials',
      locale: 'ar',
      idempotencyKey: 'staff-credentials:u1',
      [MINIMIZED_FLAG]: true,
    });
    expect(out).not.toHaveProperty('to');
    expect(out).not.toHaveProperty('variables');
  });

  it.each([JOB.WHATSAPP_SEND, JOB.WHATSAPP_RETRY])(
    'drops the recipient and variables from a completed %s job but keeps record ids',
    (name) => {
      const out = minimizeJobData(name, {
        tenantId: 't1',
        templateId: 'tpl-1',
        logId: 'log-1',
        payload: {
          accountId: 'acc-1',
          branchId: 'br-1',
          contactId: 'con-1',
          customerId: 'cus-1',
          toWaId: '966501234567',
          variables: { 1: 'Sara', 2: 'Dr Omar', 3: 'chest pain follow-up' },
          scheduledAt: '2026-10-07T09:00:00.000Z',
        },
      })!;

      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('966501234567');
      expect(serialized).not.toContain('Sara');
      expect(serialized).not.toContain('chest pain');
      expect(out).toMatchObject({
        tenantId: 't1',
        templateId: 'tpl-1',
        logId: 'log-1',
        payload: {
          accountId: 'acc-1',
          branchId: 'br-1',
          contactId: 'con-1',
          customerId: 'cus-1',
          scheduledAt: '2026-10-07T09:00:00.000Z',
        },
        [MINIMIZED_FLAG]: true,
      });
    },
  );

  it('drops the raw message text from a completed ai.execute job', () => {
    const out = minimizeJobData(JOB.AI_EXECUTE, {
      tenantId: 't1',
      aiConversationId: 'conv-1',
      content: 'I have had chest pain since Tuesday',
      idempotencyKey: 'k1',
    })!;
    expect(JSON.stringify(out)).not.toContain('chest pain');
    expect(out).toMatchObject({
      aiConversationId: 'conv-1',
      idempotencyKey: 'k1',
      [MINIMIZED_FLAG]: true,
    });
  });

  it('leaves job types that carry no content alone', () => {
    expect(
      minimizeJobData(JOB.NOTIFICATIONS_DISPATCH, { notificationId: 'n1' }),
    ).toBeNull();
    expect(
      minimizeJobData(JOB.WHATSAPP_COEXISTENCE_SYNC, { accountId: 'a' }),
    ).toBeNull();
  });

  it('is idempotent and tolerates malformed payloads', () => {
    const once = minimizeJobData(JOB.EMAIL_SEND, {
      to: 'a@b.co',
      template: 't',
    })!;
    expect(minimizeJobData(JOB.EMAIL_SEND, once)).toBeNull();
    expect(minimizeJobData(JOB.EMAIL_SEND, null)).toBeNull();
    expect(minimizeJobData(JOB.EMAIL_SEND, 'text')).toBeNull();
    expect(minimizeJobData(JOB.EMAIL_SEND, [])).toBeNull();
    expect(
      minimizeJobData(JOB.WHATSAPP_SEND, { templateId: 't' }),
    ).toMatchObject({
      payload: {},
    });
  });
});

describe('isMinimized', () => {
  it('recognises a minimised payload only', () => {
    expect(isMinimized({ [MINIMIZED_FLAG]: true })).toBe(true);
    expect(isMinimized({ to: 'a@b.co' })).toBe(false);
    expect(isMinimized(undefined)).toBe(false);
  });
});

describe('minimizeCompletedJob', () => {
  const logger = { warn: jest.fn() };
  beforeEach(() => logger.warn.mockClear());

  it('overwrites the payload of a completed content-bearing job', async () => {
    const updateData = jest.fn().mockResolvedValue(undefined);
    await minimizeCompletedJob(
      {
        name: JOB.EMAIL_SEND,
        id: 'j1',
        data: { to: 'a@b.co', template: 't', tenantId: 't1' },
        updateData,
      } as never,
      logger,
    );
    expect(updateData).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updateData.mock.calls[0][0])).not.toContain('a@b.co');
  });

  it('does nothing for a job type without content', async () => {
    const updateData = jest.fn();
    await minimizeCompletedJob(
      {
        name: JOB.NOTIFICATIONS_DISPATCH,
        id: 'j',
        data: {},
        updateData,
      } as never,
      logger,
    );
    expect(updateData).not.toHaveBeenCalled();
  });

  it('never throws when the job is already gone', async () => {
    const updateData = jest
      .fn()
      .mockRejectedValue(new Error('Missing key for job j1'));
    await expect(
      minimizeCompletedJob(
        {
          name: JOB.EMAIL_SEND,
          id: 'j1',
          data: { to: 'a@b.co' },
          updateData,
        } as never,
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not minimise'),
    );
  });

  it('tolerates an undefined job', async () => {
    await expect(
      minimizeCompletedJob(undefined, logger),
    ).resolves.toBeUndefined();
  });
});

/**
 * `ai.execute` carries the raw patient/user message (`content`). It has no live
 * caller today, which is the only reason that is acceptable. If a producer is
 * added it must persist the message and pass the row id instead (see the note
 * on `AiExecuteJob`), and this guard must be revisited deliberately — not
 * satisfied by adding a caller to the allow-list.
 */
describe('ai.execute has no producer', () => {
  const srcRoot = path.resolve(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sourceFiles(full);
      return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
    });
  }

  it('is enqueued by nothing outside the queue service itself', () => {
    const callers = sourceFiles(srcRoot)
      .filter((f) => !f.endsWith(path.join('queue', 'queue.service.ts')))
      .filter((f) => fs.readFileSync(f, 'utf8').includes('enqueueAiExecute('))
      .map((f) => path.relative(srcRoot, f));
    expect(callers).toEqual([]);
  });
});
