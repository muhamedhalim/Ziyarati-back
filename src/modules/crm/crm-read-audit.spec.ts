import { CustomerController } from './customer.controller';
import { CustomerFileController } from './customer-file.controller';
import { CustomerNoteController } from './customer-note.controller';
import { CustomerProfileController } from './customer-profile.controller';
import { PERMISSION, ROLE } from '../../rbac/rbac.constants';

/**
 * Residency plan P14 — a READ of health data outside the clinical module leaves
 * the same who / which patient / when trail a clinical read does. Wiring test:
 * the controllers are real, their collaborators are doubles.
 */
const TENANT = 't-1';
const CUSTOMER = 'c-1';
const USER = 'u-1';

function ctx(
  user: { id: string; roles: string[]; permissions: string[] } | null,
) {
  return { requireTenantId: () => TENANT, getUser: () => user } as never;
}

type Actor = { id: string; roles: string[]; permissions: string[] };

const staff: Actor = {
  id: USER,
  roles: [ROLE.RECEPTIONIST],
  permissions: [] as string[],
};
const clinician: Actor = {
  id: USER,
  roles: [ROLE.DOCTOR],
  permissions: [PERMISSION.CLINICAL_RECORDS_READ],
};

describe('read-audit of D4 reads outside the clinical module (P14)', () => {
  let record: jest.Mock;
  beforeEach(() => {
    record = jest.fn().mockResolvedValue(undefined);
  });

  it('profile read is recorded with scope "profile" after the read succeeds', async () => {
    const profiles = { get: jest.fn().mockResolvedValue({ allergies: 'x' }) };
    const c = new CustomerProfileController(profiles as never, ctx(clinician), {
      record,
    } as never);
    await expect(c.get(CUSTOMER)).resolves.toEqual({ allergies: 'x' });
    expect(record).toHaveBeenCalledWith(TENANT, CUSTOMER, USER, 'profile');
  });

  it('a failed read is NOT recorded as an access', async () => {
    const profiles = {
      get: jest.fn().mockRejectedValue(new Error('not found')),
    };
    const c = new CustomerProfileController(profiles as never, ctx(clinician), {
      record,
    } as never);
    await expect(c.get(CUSTOMER)).rejects.toThrow('not found');
    expect(record).not.toHaveBeenCalled();
  });

  it('notes list is recorded with scope "notes"', async () => {
    const notes = { list: jest.fn().mockResolvedValue({ data: [] }) };
    const c = new CustomerNoteController(notes as never, ctx(staff), {
      record,
    } as never);
    await c.list(CUSTOMER, {} as never);
    expect(record).toHaveBeenCalledWith(TENANT, CUSTOMER, USER, 'notes');
  });

  it('file list and file download are both recorded with scope "files"', async () => {
    const files = {
      list: jest.fn().mockResolvedValue({ data: [] }),
      getMetadata: jest.fn().mockResolvedValue({ id: 'f' }),
    };
    const c = new CustomerFileController(files as never, ctx(staff), {
      record,
    } as never);
    await c.list(CUSTOMER, {} as never);
    await c.getMetadata(CUSTOMER, 'f-1');
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenNthCalledWith(1, TENANT, CUSTOMER, USER, 'files');
    expect(record).toHaveBeenNthCalledWith(2, TENANT, CUSTOMER, USER, 'files');
  });

  describe('customer detail', () => {
    const make = (user: Actor | null) =>
      new CustomerController(
        { getDetails: jest.fn().mockResolvedValue({ id: CUSTOMER }) } as never,
        ctx(user),
        { record } as never,
      );

    it('is recorded only when the caller was given the health intake', async () => {
      await make(clinician).getDetails(CUSTOMER);
      expect(record).toHaveBeenCalledWith(TENANT, CUSTOMER, USER, 'profile');
    });

    it('is NOT recorded for a caller who was not shown clinical fields', async () => {
      await make(staff).getDetails(CUSTOMER);
      expect(record).not.toHaveBeenCalled();
    });

    it('a super admin is treated as having clinical access, as the permission guard does', async () => {
      await make({
        id: USER,
        roles: [ROLE.SUPER_ADMIN],
        permissions: [],
      }).getDetails(CUSTOMER);
      expect(record).toHaveBeenCalledTimes(1);
    });
  });

  it('never blocks a read when there is no acting user to attribute it to', async () => {
    const notes = { list: jest.fn().mockResolvedValue({ data: [] }) };
    const c = new CustomerNoteController(notes as never, ctx(null), {
      record,
    } as never);
    await expect(c.list(CUSTOMER, {} as never)).resolves.toEqual({ data: [] });
    expect(record).not.toHaveBeenCalled();
  });
});
