import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { QueryAppointmentsDto } from './query-appointments.dto';

/**
 * `serviceIds` validation, at the exact shape `ValidationPipe` sees a real
 * request in — plain objects as Express's query parser produces them, run
 * through `{ whitelist: true, forbidNonWhitelisted: true }` (mirrors
 * `main.ts`'s global pipe). A single query occurrence of a key comes back as
 * a bare string; two or more come back as an array — never bracket-suffixed
 * keys, which is exactly what this suite guards.
 */
const errorsFor = (payload: Record<string, unknown>) =>
  validate(plainToInstance(QueryAppointmentsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const UUID_1 = '7fcf0fed-09f9-4b0c-a822-1be28703b370';
const UUID_2 = 'd494a09f-ea9c-47e4-8f98-47ff39c65274';

describe('QueryAppointmentsDto — serviceIds', () => {
  it('accepts no serviceIds at all (no filtering)', async () => {
    const dto = plainToInstance(QueryAppointmentsDto, { page: 1, limit: 10 });
    expect(dto.serviceIds).toBeUndefined();
    expect(await errorsFor({ page: 1, limit: 10 })).toHaveLength(0);
  });

  it('normalizes a single occurrence (bare string, as Express parses one repeated key) into a one-element array', async () => {
    const dto = plainToInstance(QueryAppointmentsDto, { serviceIds: UUID_1 });
    expect(dto.serviceIds).toEqual([UUID_1]);
    expect(await errorsFor({ serviceIds: UUID_1 })).toHaveLength(0);
  });

  it('accepts multiple occurrences (array, as Express parses two+ repeated keys)', async () => {
    const dto = plainToInstance(QueryAppointmentsDto, {
      serviceIds: [UUID_1, UUID_2],
    });
    expect(dto.serviceIds).toEqual([UUID_1, UUID_2]);
    expect(await errorsFor({ serviceIds: [UUID_1, UUID_2] })).toHaveLength(0);
  });

  it('accepts duplicate ids (no dedup required — In() at the query layer is unaffected by repeats)', async () => {
    expect(await errorsFor({ serviceIds: [UUID_1, UUID_1] })).toHaveLength(0);
  });

  it('rejects a single invalid UUID', async () => {
    const errors = await errorsFor({ serviceIds: 'not-a-uuid' });
    expect(errors.some((e) => e.property === 'serviceIds')).toBe(true);
  });

  it('rejects an array containing one invalid UUID among valid ones', async () => {
    const errors = await errorsFor({ serviceIds: [UUID_1, 'not-a-uuid'] });
    expect(errors.some((e) => e.property === 'serviceIds')).toBe(true);
  });

  it('combines cleanly with status/staffId/branchId/customerId/page/limit', async () => {
    const errors = await errorsFor({
      status: 'CONFIRMED',
      staffId: UUID_1,
      branchId: UUID_2,
      customerId: UUID_1,
      serviceIds: [UUID_1, UUID_2],
      page: 2,
      limit: 20,
    });
    expect(errors).toHaveLength(0);
  });

  /**
   * Regression guard for the bracket-suffix bug (axios's default array
   * serialization emits `serviceIds[]=...`, which Express 5's default
   * `'simple'` query parser — Node's `querystring` — reads as one literal
   * property NAMED "serviceIds[]", not an array assigned to `serviceIds`).
   * The fix lives in the frontend's axios `paramsSerializer`
   * (`app/providers/axiosInstance.tsx`) emitting repeated bare keys instead —
   * the backend correctly keeps rejecting the bracket shape rather than
   * special-casing it away, per the "no workaround" requirement.
   */
  it('still rejects the bracket-suffixed key shape (proves the fix belongs in the client, not a DTO workaround)', async () => {
    const errors = await errorsFor({ 'serviceIds[]': UUID_1 });
    expect(errors.some((e) => e.property === 'serviceIds[]')).toBe(true);
  });
});
