import {
  toIntegrationService,
  toIntegrationStaff,
  toIntegrationCustomer,
  toIntegrationAppointment,
} from './integration.mappers';

/**
 * These are ALLOWLIST contracts: each test asserts the exact key set the
 * mapper returns, so a future field added to the source entity does NOT leak
 * into the external API just because someone spread the entity — it has to be
 * added here deliberately.
 */
describe('integration.mappers', () => {
  it('toIntegrationService returns only the allowlisted fields', () => {
    const out = toIntegrationService({
      id: 's1',
      name: 'Cleaning',
      description: 'desc',
      duration_minutes: 30,
      pricing_type: 'FIXED',
      base_price: 100,
      is_active: true,
      category: { id: 'c1', name: 'Dental' },
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-02T00:00:00Z'),
      deleted_at: undefined,
    } as any);
    expect(Object.keys(out).sort()).toEqual(
      [
        'id',
        'name',
        'description',
        'durationMinutes',
        'pricingType',
        'basePrice',
        'isActive',
        'categoryId',
        'categoryName',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
  });

  it('toIntegrationStaff never exposes the linked user credentials/contact info or internal auth fields', () => {
    const out = toIntegrationStaff({
      id: 'sp1',
      title: 'Dr.',
      bio: 'bio',
      is_available_for_booking: true,
      booking_buffer_minutes: 5,
      avatar_url: 'https://signed-url.example/x',
      avatar_storage_key: 'tenant/staff-avatar/x.png',
      created_at: new Date('2026-01-01T00:00:00Z'),
      user: {
        id: 'u1',
        full_name: 'Sara',
        email: 'sara@example.com',
        phone: '0500000000',
        password_hash: 'should-never-appear',
        roles: ['owner'],
      },
      commissions: [{ amount: 999 }],
      ratings: [{ score: 5 }],
    } as any);
    expect(Object.keys(out).sort()).toEqual(
      ['id', 'fullName', 'title', 'bio', 'isAvailableForBooking', 'createdAt'].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/password_hash|should-never-appear/);
    expect(JSON.stringify(out)).not.toMatch(/sara@example\.com|0500000000/);
  });

  it('toIntegrationCustomer excludes whatsapp linkage, gender, DOB, marketing/source metadata', () => {
    const out = toIntegrationCustomer({
      id: 'cu1',
      full_name: 'Ahmed',
      phone: '0511111111',
      email: 'ahmed@example.com',
      is_active: true,
      whatsapp_id: 'wa-secret-id',
      whatsapp_name: 'Ahmed WA',
      gender: 'male',
      date_of_birth: new Date('1990-01-01'),
      source: 'referral',
      marketing_opt_in: true,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: undefined,
    } as any);
    expect(Object.keys(out).sort()).toEqual(
      ['id', 'fullName', 'phone', 'email', 'isActive', 'createdAt', 'updatedAt'].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/wa-secret-id|gender|male|marketing|referral/);
  });

  it('toIntegrationAppointment excludes clinical notes and every payment field', () => {
    const out = toIntegrationAppointment({
      id: 'a1',
      start_at: new Date('2026-01-01T10:00:00Z'),
      end_at: new Date('2026-01-01T10:30:00Z'),
      status: 'CONFIRMED',
      source: 'WHATSAPP_BOT',
      notes: 'patient reported severe symptoms — CONFIDENTIAL',
      total_amount: 500,
      currency: 'SAR',
      payment_status: 'PAID',
      version: 3,
      branch: { id: 'b1' },
      staff: { id: 'st1' },
      customer: { id: 'cu1' },
      booked_by: { id: 'u1' },
      created_at: new Date('2026-01-01T09:00:00Z'),
      updated_at: undefined,
    } as any);
    expect(Object.keys(out).sort()).toEqual(
      [
        'id',
        'startAt',
        'endAt',
        'status',
        'source',
        'branchId',
        'staffId',
        'customerId',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/CONFIDENTIAL|severe symptoms|500|PAID|SAR/);
  });
});
