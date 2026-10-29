import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { WhatsappContactService } from './whatsapp-contact.service';
import { WhatsappContact } from '../../entities/WhatsApp/WhatsappContact';
import { Customer } from '../../entities/CRM/Customer';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const uniqueViolation = () => Object.assign(new Error('duplicate key'), { code: '23505' });

describe('WhatsappContactService', () => {
  let service: WhatsappContactService;
  let contacts: MockRepository;
  let customers: MockRepository;

  beforeEach(async () => {
    contacts = createMockRepository();
    customers = createMockRepository();
    contacts.create.mockImplementation((v: object) => ({ ...v }));
    contacts.save.mockImplementation(async (v: object) => ({ id: 'contact-1', ...v }));

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappContactService,
        { provide: getRepositoryToken(WhatsappContact), useValue: contacts },
        { provide: getRepositoryToken(Customer), useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(WhatsappContactService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create', () => {
    it('creates a contact for the tenant', async () => {
      const res = await service.create(TENANT, { waId: '966501234567' });
      expect(res).toMatchObject({ wa_id: '966501234567' });
      expect(contacts.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenant: { id: TENANT }, wa_id: '966501234567' }),
      );
    });

    it('maps a unique-constraint race on (tenant, wa_id) to a clean 409, not a raw DB error', async () => {
      contacts.save.mockRejectedValueOnce(uniqueViolation());

      await expect(service.create(TENANT, { waId: '966501234567' })).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('rethrows a DB error that is not the wa_id race', async () => {
      const err = new Error('connection lost');
      contacts.save.mockRejectedValueOnce(err);

      await expect(service.create(TENANT, { waId: '966501234567' })).rejects.toBe(err);
    });
  });

  describe('update', () => {
    it('maps a wa_id that another contact of the tenant already holds to a clean 409', async () => {
      contacts.findOne.mockResolvedValueOnce({ id: 'contact-1', wa_id: 'old' });
      contacts.save.mockRejectedValueOnce(uniqueViolation());

      await expect(service.update(TENANT, 'contact-1', { waId: 'taken' })).rejects.toMatchObject({
        code: ErrorCode.CONFLICT,
      });
    });

    it('rethrows a DB error that is not the wa_id uniqueness violation', async () => {
      const err = new Error('connection lost');
      contacts.findOne.mockResolvedValueOnce({ id: 'contact-1', wa_id: 'old' });
      contacts.save.mockRejectedValueOnce(err);

      await expect(service.update(TENANT, 'contact-1', { waId: 'new' })).rejects.toBe(err);
    });
  });

  describe('bulkImport', () => {
    it('skips wa_ids already present for the tenant', async () => {
      contacts.find.mockResolvedValueOnce([{ id: 'existing', wa_id: 'a' }]);

      const res = await service.bulkImport(TENANT, {
        contacts: [{ waId: 'a' }, { waId: 'b' }],
      });

      expect(res).toEqual({ requested: 2, imported: 1, skipped: 1 });
      expect(contacts.save).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ wa_id: 'b' })]),
      );
    });

    it('falls back to per-row inserts when the batch save loses a uniqueness race, keeping the rest', async () => {
      contacts.find.mockResolvedValueOnce([]); // pre-check finds nothing yet
      contacts.save
        .mockRejectedValueOnce(uniqueViolation()) // batch save fails
        .mockResolvedValueOnce({ id: '1', wa_id: 'a' }) // row 'a' succeeds
        .mockRejectedValueOnce(uniqueViolation()) // row 'b' lost the race concurrently
        .mockResolvedValueOnce({ id: '3', wa_id: 'c' }); // row 'c' succeeds

      const res = await service.bulkImport(TENANT, {
        contacts: [{ waId: 'a' }, { waId: 'b' }, { waId: 'c' }],
      });

      expect(res).toEqual({ requested: 3, imported: 2, skipped: 1 });
    });

    it('rethrows a non-uniqueness batch failure', async () => {
      contacts.find.mockResolvedValueOnce([]);
      const err = new Error('connection lost');
      contacts.save.mockRejectedValueOnce(err);

      await expect(
        service.bulkImport(TENANT, { contacts: [{ waId: 'a' }] }),
      ).rejects.toBe(err);
    });
  });
});
