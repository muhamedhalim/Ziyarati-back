import { NotificationLogService } from './notification-log.service';

/**
 * Residency plan P7: a provider or transport error can echo the recipient's
 * number, an e-mail address or a token. The log service is the single write
 * seam for `notification_logs.error_message`, so it scrubs there.
 */
describe('NotificationLogService.record', () => {
  function build() {
    const saved: Array<Record<string, unknown>> = [];
    const repo = {
      create: (v: Record<string, unknown>) => v,
      save: async (v: Record<string, unknown>) => {
        saved.push(v);
        return v;
      },
    };
    const svc = new NotificationLogService(repo as never);
    return { svc, saved };
  }

  it('scrubs phone numbers, e-mail addresses and tokens from error_message', async () => {
    const { svc, saved } = build();
    await svc.record('t1', {
      status: 'FAILED',
      errorMessage:
        'Meta 131026: recipient +966501234567 undeliverable; contact sara@example.com; Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    });
    const msg = String(saved[0].error_message);
    expect(msg).not.toContain('501234567');
    expect(msg).not.toContain('sara@example.com');
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(msg).toContain('131026');
  });

  it('keeps a plain operational reason readable', async () => {
    const { svc, saved } = build();
    await svc.record('t1', {
      status: 'FAILED',
      errorMessage: 'whatsapp provider send failed',
    });
    expect(saved[0].error_message).toBe('whatsapp provider send failed');
  });

  it('leaves error_message undefined when none is given', async () => {
    const { svc, saved } = build();
    await svc.record('t1', { status: 'SENT' });
    expect(saved[0].error_message).toBeUndefined();
  });

  it('caps an oversized reason', async () => {
    const { svc, saved } = build();
    await svc.record('t1', {
      status: 'FAILED',
      errorMessage: 'x'.repeat(5000),
    });
    expect(String(saved[0].error_message).length).toBeLessThan(1000);
  });
});
