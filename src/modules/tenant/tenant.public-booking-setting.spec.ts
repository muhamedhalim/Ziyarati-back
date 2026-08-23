import { TenantService } from './tenant.service';

/**
 * The clinic's opt-in to the PUBLIC (anonymous) booking assistant.
 *
 * `tenant_settings.public_booking_enabled` has existed since
 * `1730032000000-TenantSettingPublicBooking`, and every public-discovery query
 * gates on it (`ELIGIBLE_CLINIC`). Nothing ever WROTE it: the DTO carried no
 * field and `updateSettings`' assign list had no entry, so it sat at its `false`
 * default forever. `list_cities` and `search_clinics` therefore returned an
 * empty set for every visitor on every environment, and the public chatbot could
 * only ever answer "there are no clinics available for booking" — about clinics
 * that plainly existed, were approved, active, and had branches.
 *
 * These lock the write path down: the flag is settable, and — like every other
 * field on this endpoint — an omitted value preserves what is stored rather than
 * silently switching a live clinic off.
 */
describe('TenantService.updateSettings — public booking opt-in', () => {
  const build = (stored: Record<string, unknown>) => {
    const saved: Record<string, unknown>[] = [];
    const settings = {
      findOne: jest.fn().mockResolvedValue(stored),
      create: jest.fn(),
      save: jest.fn(async (row: Record<string, unknown>) => {
        saved.push({ ...row });
        return row;
      }),
    };
    const service = new TenantService(
      {} as never, // tenants
      settings as never,
      {} as never, // approvalEvents
      {} as never, // dataSource
    );
    return { service, saved };
  };

  const stored = {
    public_booking_enabled: false,
    payment_required: true,
    bot_enabled: true,
    enforce_staff_working_hours: false,
  };

  it('turns public booking ON — the write path that did not exist', async () => {
    const f = build({ ...stored });

    await f.service.updateSettings('tenant-1', { publicBookingEnabled: true });

    expect(f.saved[0].public_booking_enabled).toBe(true);
  });

  it('turns it back OFF', async () => {
    const f = build({ ...stored, public_booking_enabled: true });

    await f.service.updateSettings('tenant-1', { publicBookingEnabled: false });

    expect(f.saved[0].public_booking_enabled).toBe(false);
  });

  it('preserves an enabled clinic when the field is omitted', async () => {
    // `?? stored` semantics, same as every other field here: a partial update
    // that says nothing about public booking must not take a live clinic off
    // the public assistant.
    const f = build({ ...stored, public_booking_enabled: true });

    await f.service.updateSettings('tenant-1', { paymentRequired: false });

    expect(f.saved[0].public_booking_enabled).toBe(true);
  });
});
