import { sanitizeExternalInput, EXTERNAL_WRITABLE_FIELDS } from './source-of-truth';
import { INTEGRATION_RESOURCE } from '../integration-platform.constants';

const APPT = INTEGRATION_RESOURCE.APPOINTMENT;

/**
 * Appointments carry money and a strict lifecycle. An external system may only
 * describe WHEN/WHO/WHAT; every financial, settlement, ownership, concurrency
 * and status field is platform-owned and must be rejected outright.
 */
describe('source-of-truth — appointment safety', () => {
  it('allows ONLY scheduling/reference fields (currency deliberately excluded)', () => {
    expect([...EXTERNAL_WRITABLE_FIELDS[APPT]].sort()).toEqual(
      ['branchId', 'customerId', 'endAt', 'notes', 'serviceIds', 'staffId', 'startAt'].sort(),
    );
    expect(EXTERNAL_WRITABLE_FIELDS[APPT]).not.toContain('currency');
  });

  it.each([
    // Lifecycle + ownership
    ['status'], ['booked_by'], ['bookedBy'], ['cancelled_by'], ['cancelledBy'],
    ['rescheduled_by'], ['rescheduledBy'], ['slot'], ['source'],
    // Money / settlement / provider references
    ['refund_amount'], ['refundAmount'], ['transaction_id'], ['transactionId'],
    ['provider_reference'], ['providerReference'], ['payment_id'], ['paymentId'],
  ])('rejects the protected appointment field %s with 422', (field) => {
    expect(() => sanitizeExternalInput(APPT, { [field]: 'x' })).toThrow();
  });

  it.each([
    ['total_amount'], ['totalAmount'], ['currency'],
    ['payment_status'], ['paymentStatus'],
    ['settlement_status'], ['settlementStatus'],
    ['platform_fee'], ['platformFee'],
    ['id'], ['tenantId'], ['version'], ['created_at'], ['deleted_at'],
  ])('rejects the globally protected field %s with 422', (field) => {
    expect(() => sanitizeExternalInput(APPT, { [field]: 'x' })).toThrow();
  });

  it('keeps scheduling fields and drops read-only reference hints from the write', () => {
    const { clean } = sanitizeExternalInput(APPT, {
      startAt: '2026-08-01T09:00:00+03:00',
      endAt: '2026-08-01T09:45:00+03:00',
      notes: 'Prefers morning',
      // Read-only hints consumed by the adapter, never written to the record:
      customerExternalId: 'PMS-C-1',
      staffExternalId: 'PMS-S-1',
      branchExternalId: 'PMS-B-1',
      serviceExternalIds: ['PMS-SV-1'],
      action: 'reschedule',
      reason: 'Patient request',
    });
    expect(clean).toEqual({
      startAt: '2026-08-01T09:00:00+03:00',
      endAt: '2026-08-01T09:45:00+03:00',
      notes: 'Prefers morning',
    });
    for (const hint of ['customerExternalId', 'staffExternalId', 'branchExternalId', 'serviceExternalIds', 'action', 'reason']) {
      expect(clean).not.toHaveProperty(hint);
    }
  });

  it('accepts explicit internal ids (the lifecycle service tenant-validates them)', () => {
    const { clean } = sanitizeExternalInput(APPT, {
      branchId: 'b1', customerId: 'c1', staffId: 's1', serviceIds: ['sv1'],
    });
    expect(clean).toEqual({ branchId: 'b1', customerId: 'c1', staffId: 's1', serviceIds: ['sv1'] });
  });
});
