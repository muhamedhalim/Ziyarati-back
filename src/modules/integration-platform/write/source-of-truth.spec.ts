import { AppError } from '../../../common/errors';
import {
  CONFLICT_POLICY,
  INTEGRATION_RESOURCE,
} from '../integration-platform.constants';
import {
  decideConflict,
  protectedFieldsFor,
  sanitizeExternalInput,
} from './source-of-truth';

describe('source-of-truth engine', () => {
  describe('sanitizeExternalInput', () => {
    it('keeps only allowlisted customer fields and drops unknown ones', () => {
      const { clean, providedFields } = sanitizeExternalInput(INTEGRATION_RESOURCE.CUSTOMER, {
        full_name: 'Sara',
        phone: '+966500000000',
        email: 'sara@example.com',
        unknown_field: 'ignored',
      });
      expect(clean).toEqual({
        full_name: 'Sara',
        phone: '+966500000000',
        email: 'sara@example.com',
      });
      expect(providedFields.sort()).toEqual(['email', 'full_name', 'phone']);
    });

    it('rejects a global protected field (tenant) with 422', () => {
      expect(() =>
        sanitizeExternalInput(INTEGRATION_RESOURCE.CUSTOMER, {
          phone: '+966500000000',
          tenantId: 'other-tenant',
        }),
      ).toThrow(AppError);
    });

    it('rejects financial protected fields on any resource', () => {
      expect(() =>
        sanitizeExternalInput(INTEGRATION_RESOURCE.SERVICE, {
          name: 'X',
          payment_status: 'PAID',
        }),
      ).toThrow(AppError);
    });

    it('rejects staff roles/permissions/credentials (mass-assignment defense)', () => {
      for (const field of ['roles', 'permissions', 'password_hash', 'userId', 'commission']) {
        expect(() =>
          sanitizeExternalInput(INTEGRATION_RESOURCE.STAFF, { title: 'Dr', [field]: 'x' }),
        ).toThrow(AppError);
      }
    });

    it('allows staff profile-only fields (named to match UpdateStaffDto)', () => {
      const { clean } = sanitizeExternalInput(INTEGRATION_RESOURCE.STAFF, {
        title: 'Dentist',
        bio: 'Hi',
        isAvailableForBooking: true,
        bookingBufferMinutes: 10,
      });
      expect(clean).toEqual({
        title: 'Dentist',
        bio: 'Hi',
        isAvailableForBooking: true,
        bookingBufferMinutes: 10,
      });
    });

    it('protects customer whatsapp linkage', () => {
      expect(protectedFieldsFor(INTEGRATION_RESOURCE.CUSTOMER).has('whatsapp_id')).toBe(true);
    });
  });

  describe('decideConflict', () => {
    const current = { full_name: 'Old', phone: '+900', is_active: true };

    it('no changes → do not apply, do not report', () => {
      const d = decideConflict(CONFLICT_POLICY.EXTERNAL_WINS, { full_name: 'Old' }, current);
      expect(d).toEqual({ apply: false, report: false, changedFields: [] });
    });

    it('external_wins applies changed fields', () => {
      const d = decideConflict(CONFLICT_POLICY.EXTERNAL_WINS, { full_name: 'New' }, current);
      expect(d.apply).toBe(true);
      expect(d.report).toBe(false);
      expect(d.changedFields).toEqual(['full_name']);
    });

    it('platform_wins keeps the platform record', () => {
      const d = decideConflict(CONFLICT_POLICY.PLATFORM_WINS, { full_name: 'New' }, current);
      expect(d.apply).toBe(false);
      expect(d.report).toBe(false);
      expect(d.changedFields).toEqual(['full_name']);
    });

    it('reject_and_report flags without applying', () => {
      const d = decideConflict(CONFLICT_POLICY.REJECT_AND_REPORT, { full_name: 'New' }, current);
      expect(d.apply).toBe(false);
      expect(d.report).toBe(true);
      expect(d.changedFields).toEqual(['full_name']);
    });

    it('treats decimal-string vs number as equal (no false conflict)', () => {
      const d = decideConflict(
        CONFLICT_POLICY.REJECT_AND_REPORT,
        { basePrice: 80 },
        { basePrice: '80.00' },
      );
      expect(d.changedFields).toEqual([]);
      expect(d.report).toBe(false);
    });
  });
});
