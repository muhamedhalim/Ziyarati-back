import {
  sanitizeExternalInput,
  protectedFieldsFor,
  EXTERNAL_WRITABLE_FIELDS,
} from './source-of-truth';
import { INTEGRATION_RESOURCE } from '../integration-platform.constants';

const STAFF = INTEGRATION_RESOURCE.STAFF;

/**
 * Staff is the highest-risk resource: a StaffProfile is bound 1:1 to a real
 * login account for life. These tests pin the guarantees that an external
 * system can NEVER touch identity, authorization, access, money or reputation.
 */
describe('source-of-truth — staff account safety', () => {
  it('allows ONLY approved profile/booking fields', () => {
    expect([...EXTERNAL_WRITABLE_FIELDS[STAFF]].sort()).toEqual(
      ['bio', 'bookingBufferMinutes', 'isAvailableForBooking', 'title'].sort(),
    );
  });

  it.each([
    ['user'], ['userId'], ['user_id'],
    ['email'], ['is_active'], ['isActive'],
    ['roles'], ['role'], ['permissions'],
    ['password'], ['password_hash'],
    ['dashboard_access'], ['dashboardAccess'],
    ['commission'], ['commission_rate'], ['commissions'],
    ['payout'], ['payouts'], ['rating'], ['ratings'],
    ['avatar_storage_key'], ['avatarStorageKey'], ['avatar_url'], ['avatarUrl'],
  ])('rejects the protected staff field %s with 422', (field) => {
    expect(() => sanitizeExternalInput(STAFF, { [field]: 'x' })).toThrow();
  });

  it('rejects globally protected identity/ownership/financial fields', () => {
    for (const field of ['id', 'tenantId', 'tenant_id', 'created_at', 'version', 'payment_status', 'platform_fee']) {
      expect(() => sanitizeExternalInput(STAFF, { [field]: 'x' })).toThrow();
    }
  });

  it('keeps approved fields and silently drops unknown noise', () => {
    const { clean } = sanitizeExternalInput(STAFF, {
      title: 'Lead Physio',
      bio: 'Sports rehab',
      isAvailableForBooking: false,
      bookingBufferMinutes: 15,
      somethingUnknown: 'ignored',
    });
    expect(clean).toEqual({
      title: 'Lead Physio',
      bio: 'Sports rehab',
      isAvailableForBooking: false,
      bookingBufferMinutes: 15,
    });
    expect(clean).not.toHaveProperty('somethingUnknown');
  });

  it('treats `matchEmail` as a read-only hint: never writable, never rejected', () => {
    // Not an attack (so no 422) …
    const { clean } = sanitizeExternalInput(STAFF, { matchEmail: 'a@x.com', title: 'T' });
    // … and never written to the record.
    expect(clean).not.toHaveProperty('matchEmail');
    expect(clean).toEqual({ title: 'T' });
    // It is also NOT in the protected set — sending it is legitimate.
    expect(protectedFieldsFor(STAFF).has('matchEmail')).toBe(false);
  });

  it('protects `email` from being written even though matching by email is allowed', () => {
    expect(protectedFieldsFor(STAFF).has('email')).toBe(true);
    expect(() => sanitizeExternalInput(STAFF, { email: 'attacker@evil.com' })).toThrow();
  });
});
