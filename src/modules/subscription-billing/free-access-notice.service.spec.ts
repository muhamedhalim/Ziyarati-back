import { FreeAccessNoticeService } from './free-access-notice.service';
import { DataSource } from 'typeorm';
import { InternalNotificationService } from '../notifications/internal/internal-notification.service';
import { EmailService } from '../email/email.service';
import { MetricsService } from '../../metrics/metrics.service';

// Dates are computed relative to `Date.now()` (never a hardcoded literal) so
// this spec's staleness assertions ("already expired" vs "still active") stay
// correct regardless of when it runs.
const FUTURE_STARTS_AT = new Date(Date.now() - 1 * 86_400_000).toISOString(); // yesterday
const FUTURE_ENDS_AT = new Date(Date.now() + 29 * 86_400_000).toISOString(); // +29d (≈30d span)
const PAST_ENDS_AT = new Date(Date.now() - 1 * 86_400_000).toISOString();

const overrideRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ov-1',
  tenant_id: 't1',
  tenant_name: 'Acme Clinic',
  contact_email: 'owner@acme.test',
  starts_at: FUTURE_STARTS_AT,
  ends_at: FUTURE_ENDS_AT,
  status: 'ACTIVE',
  tenant_deleted_at: null,
  ...overrides,
});

describe('FreeAccessNoticeService', () => {
  let service: FreeAccessNoticeService;
  let query: jest.Mock;
  let emit: jest.Mock;
  let sendFreeAccessNotification: jest.Mock;
  let recordFreeAccessNotice: jest.Mock;

  const emitResult = (over: Partial<{ resolved: number; created: number; error?: string }> = {}) => ({
    key: 'FREE_ACCESS_STARTED',
    resolved: 1,
    suppressed: 0,
    created: 1,
    ...over,
  });

  beforeEach(() => {
    query = jest.fn();
    emit = jest.fn().mockResolvedValue(emitResult());
    sendFreeAccessNotification = jest.fn();
    recordFreeAccessNotice = jest.fn();

    service = new FreeAccessNoticeService(
      { query } as unknown as DataSource,
      { emit } as unknown as InternalNotificationService,
      { sendFreeAccessNotification } as unknown as EmailService,
      { recordFreeAccessNotice } as unknown as MetricsService,
    );
  });

  /** query() call #1 = loadOverride; call #2 (only reached for email) = the users lookup. */
  function mockOverride(row: ReturnType<typeof overrideRow> | null) {
    query.mockResolvedValueOnce(row ? [row] : []);
  }
  function mockUserLocale(locale: string | null = null) {
    query.mockResolvedValueOnce(locale ? [{ preferred_locale: locale }] : []);
  }

  describe('happy path — STARTED', () => {
    it('emits in-app, sends email, and records "sent" for both channels', async () => {
      mockOverride(overrideRow());
      mockUserLocale('ar');

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(emit).toHaveBeenCalledWith(
        'FREE_ACCESS_STARTED',
        expect.objectContaining({
          tenantId: 't1',
          variables: {
            clinicName: 'Acme Clinic',
            endsAt: FUTURE_ENDS_AT,
            durationDays: '30',
          },
          refs: { overrideId: 'ov-1', endsAt: FUTURE_ENDS_AT },
        }),
      );
      expect(sendFreeAccessNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'owner@acme.test',
          event: 'started',
          clinicName: 'Acme Clinic',
          durationDays: '30',
          endsAt: FUTURE_ENDS_AT,
          tenantId: 't1',
          locale: 'ar',
          idempotencyKey: 'free-access:ov-1:started',
        }),
      );
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'in_app', 'sent');
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'email', 'sent');
    });

    it('renders "unlimited"/"no end date" for an unlimited override', async () => {
      mockOverride(overrideRow({ ends_at: null }));
      mockUserLocale(null);

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(emit).toHaveBeenCalledWith(
        'FREE_ACCESS_STARTED',
        expect.objectContaining({
          variables: {
            clinicName: 'Acme Clinic',
            endsAt: 'no end date',
            durationDays: 'unlimited',
          },
        }),
      );
    });
  });

  describe('happy path — EXPIRING', () => {
    it('emits and emails the expiry warning when ends_at matches the claimed date', async () => {
      const endsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
      mockOverride(overrideRow({ ends_at: endsAt }));
      mockUserLocale(null);

      await service.deliver({ overrideId: 'ov-1', kind: 'EXPIRING', endsAt });

      expect(emit).toHaveBeenCalledWith('FREE_ACCESS_EXPIRING', expect.any(Object));
      expect(sendFreeAccessNotification).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'expiring', idempotencyKey: expect.stringContaining('expiring') }),
      );
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('expiring', 'in_app', 'sent');
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('expiring', 'email', 'sent');
    });
  });

  describe('staleness', () => {
    it('skips delivery when the override no longer exists', async () => {
      mockOverride(null);

      await service.deliver({ overrideId: 'missing', kind: 'STARTED' });

      expect(emit).not.toHaveBeenCalled();
      expect(sendFreeAccessNotification).not.toHaveBeenCalled();
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'in_app', 'stale');
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'email', 'stale');
    });

    it('skips when the tenant was soft-deleted', async () => {
      mockOverride(overrideRow({ tenant_deleted_at: '2026-02-01T00:00:00.000Z' }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(emit).not.toHaveBeenCalled();
    });

    it('skips when the override was revoked', async () => {
      mockOverride(overrideRow({ status: 'REVOKED' }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(emit).not.toHaveBeenCalled();
    });

    it('skips when the override has already fully expired', async () => {
      mockOverride(overrideRow({ ends_at: '2020-01-01T00:00:00.000Z' }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(emit).not.toHaveBeenCalled();
    });

    it('skips an EXPIRING job whose claimed ends_at no longer matches (extended in between)', async () => {
      // The override was extended (a later ends_at) after the sweep claimed
      // the job for the ORIGINAL (now stale) ends_at.
      mockOverride(overrideRow({ ends_at: new Date(Date.now() + 60 * 86_400_000).toISOString() }));

      await service.deliver({
        overrideId: 'ov-1',
        kind: 'EXPIRING',
        endsAt: FUTURE_ENDS_AT, // the stale, already-superseded claim
      });

      expect(emit).not.toHaveBeenCalled();
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('expiring', 'in_app', 'stale');
    });
  });

  describe('in-app outcomes', () => {
    it('records "failed" and throws (for BullMQ retry) when emit() reports an error', async () => {
      mockOverride(overrideRow());
      emit.mockResolvedValueOnce(emitResult({ error: 'db down' }));

      await expect(
        service.deliver({ overrideId: 'ov-1', kind: 'STARTED' }),
      ).rejects.toThrow(/db down/);

      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'in_app', 'failed');
      // The whole delivery is retried as one unit — email must not have run yet.
      expect(sendFreeAccessNotification).not.toHaveBeenCalled();
    });

    it('records "no_recipient" when nobody resolved (no SUBSCRIPTION_MANAGE holder)', async () => {
      mockOverride(overrideRow());
      mockUserLocale(null);
      emit.mockResolvedValueOnce(emitResult({ resolved: 0, created: 0 }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'in_app', 'no_recipient');
      // Email is independent of in-app recipient resolution.
      expect(sendFreeAccessNotification).toHaveBeenCalled();
    });

    it('records "duplicate" when the DB insert produced no new rows', async () => {
      mockOverride(overrideRow());
      mockUserLocale(null);
      emit.mockResolvedValueOnce(emitResult({ resolved: 1, created: 0 }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'in_app', 'duplicate');
    });
  });

  describe('email outcomes', () => {
    it('records "no_recipient" and skips the send when contact_email is missing', async () => {
      mockOverride(overrideRow({ contact_email: null }));

      await service.deliver({ overrideId: 'ov-1', kind: 'STARTED' });

      expect(sendFreeAccessNotification).not.toHaveBeenCalled();
      expect(recordFreeAccessNotice).toHaveBeenCalledWith('started', 'email', 'no_recipient');
      // In-app is independent of email recipient availability.
      expect(emit).toHaveBeenCalled();
    });
  });
});
