import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CustomerNoteService } from './customer-note.service';
import { CustomerService } from './customer.service';
import { CustomerNote } from '../../entities/CRM/CustomerNote';
import { ErrorCode } from '../../common/errors';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

const TENANT = 't1';
const CUSTOMER = 'c1';

describe('CustomerNoteService', () => {
  let service: CustomerNoteService;
  let notes: MockRepository;
  let customers: { findOneOrThrow: jest.Mock };

  beforeEach(async () => {
    notes = createMockRepository();
    customers = { findOneOrThrow: jest.fn().mockResolvedValue({ id: CUSTOMER }) };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CustomerNoteService,
        { provide: getRepositoryToken(CustomerNote), useValue: notes },
        { provide: CustomerService, useValue: customers },
      ],
    }).compile();
    service = moduleRef.get(CustomerNoteService);
  });

  afterEach(() => jest.clearAllMocks());

  it('adds a note after verifying the parent customer is tenant-owned', async () => {
    notes.save.mockResolvedValueOnce({ id: 'n1' });
    await service.add(TENANT, CUSTOMER, { content: 'hi' } as any, 'user-1');
    expect(customers.findOneOrThrow).toHaveBeenCalledWith(TENANT, CUSTOMER);
    const created = notes.create.mock.calls[0][0];
    expect(created.user).toEqual({ id: 'user-1' });
  });

  it('updates a note', async () => {
    notes.findOne.mockResolvedValueOnce({ id: 'n1', content: 'old' });
    notes.save.mockImplementationOnce(async (n: any) => n);
    const res = await service.update(TENANT, CUSTOMER, 'n1', { content: 'new' } as any);
    expect(res).toEqual(expect.objectContaining({ content: 'new' }));
  });

  it('throws when the note does not exist', async () => {
    notes.findOne.mockResolvedValueOnce(null);
    await expect(service.update(TENANT, CUSTOMER, 'x', {} as any)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('removes a note', async () => {
    notes.findOne.mockResolvedValueOnce({ id: 'n1' });
    const res = await service.remove(TENANT, CUSTOMER, 'n1');
    expect(notes.remove).toHaveBeenCalled();
    expect(res).toEqual({ id: 'n1', deleted: true });
  });

  it('lists notes for a customer', async () => {
    notes.findAndCount.mockResolvedValueOnce([[{ id: 'n1' }], 1]);
    const res = await service.list(TENANT, CUSTOMER, { page: 1, limit: 10 } as any);
    expect(res.total).toBe(1);
  });
});
