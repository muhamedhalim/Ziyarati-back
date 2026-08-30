import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import { EmailSuppressionService } from './email-suppression.service';
import { EmailSuppression } from '../../entities/System/EmailSuppression';
import {
  createMockRepository,
  createMockQueryBuilder,
  MockRepository,
} from '../../../test/utils/mock-factories';

describe('EmailSuppressionService', () => {
  let service: EmailSuppressionService;
  let repo: MockRepository;

  beforeEach(async () => {
    repo = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EmailSuppressionService,
        { provide: getRepositoryToken(EmailSuppression), useValue: repo },
      ],
    }).compile();
    service = moduleRef.get(EmailSuppressionService);
  });

  describe('normalize', () => {
    it('lowercases and trims', () => {
      expect(EmailSuppressionService.normalize('  Patient@Example.COM  ')).toBe(
        'patient@example.com',
      );
    });
  });

  describe('isSuppressed', () => {
    it('normalizes the address before checking', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await service.isSuppressed('t1', '  Patient@Example.COM ');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { tenant: { id: 't1' }, email: 'patient@example.com' },
      });
    });

    it('returns true when a row exists', async () => {
      repo.findOne.mockResolvedValueOnce({ id: 'row-1' });
      await expect(service.isSuppressed('t1', 'a@b.com')).resolves.toBe(true);
    });

    it('returns false when no row exists', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      await expect(service.isSuppressed('t1', 'a@b.com')).resolves.toBe(false);
    });
  });

  describe('suppress', () => {
    it('inserts a lowercased, tenant-scoped row via ON CONFLICT DO NOTHING (idempotent)', async () => {
      const qb = createMockQueryBuilder();
      repo.createQueryBuilder.mockReturnValue(qb);

      await service.suppress('t1', 'Patient@Example.com', 'bounce', 'webhook');

      expect(qb.insert).toHaveBeenCalled();
      expect(qb.into).toHaveBeenCalledWith(EmailSuppression);
      expect(qb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant: { id: 't1' },
          email: 'patient@example.com',
          reason: 'bounce',
          source: 'webhook',
        }),
      );
      expect(qb.orIgnore).toHaveBeenCalled();
      expect(qb.execute).toHaveBeenCalled();
    });

    it('propagates a genuine database failure (this IS the suppression, not a best-effort audit log)', async () => {
      const qb = createMockQueryBuilder();
      qb.execute.mockRejectedValueOnce(new Error('connection lost'));
      repo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.suppress('t1', 'a@b.com', 'bounce', 'webhook'),
      ).rejects.toThrow('connection lost');
    });
  });
});
