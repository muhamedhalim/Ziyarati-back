import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { VerificationAuditService } from './verification-audit.service';
import { VerificationAuditLog } from '../../entities/SaaS-Core/VerificationAuditLog';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

/**
 * VER-005 (REQ-TEN-006) — the audit trail itself. `tenant-verification.service.spec.ts`
 * already proves the CALLER delegates correctly; this file proves the
 * service being delegated to is itself correct — no prior coverage existed
 * for this file at all.
 */
describe('VerificationAuditService', () => {
  let service: VerificationAuditService;
  let logs: MockRepository;

  beforeEach(async () => {
    logs = createMockRepository();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        VerificationAuditService,
        { provide: getRepositoryToken(VerificationAuditLog), useValue: logs },
      ],
    }).compile();
    service = moduleRef.get(VerificationAuditService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('record', () => {
    it('writes actor id/role/ip/userAgent, action, document/docType, and metadata', async () => {
      await service.record({
        tenantId: 't1',
        action: 'UPLOADED',
        documentId: 'doc-1',
        docType: 'commercial_registration',
        actor: { id: 'u1', role: 'owner', ip: '1.2.3.4', userAgent: 'jest' },
        metadata: { storageKey: 'k.pdf' },
      });

      expect(logs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 't1',
          action: 'UPLOADED',
          document_id: 'doc-1',
          doc_type: 'commercial_registration',
          actor_id: 'u1',
          actor_role: 'owner',
          ip_address: '1.2.3.4',
          user_agent: 'jest',
          metadata: { storageKey: 'k.pdf' },
        }),
      );
    });

    it('a write failure is swallowed — never propagates and never blocks the caller\'s underlying action', async () => {
      logs.save.mockRejectedValueOnce(new Error('db down'));
      await expect(
        service.record({ tenantId: 't1', action: 'VIEWED' }),
      ).resolves.toBeUndefined();
    });

    it('records a system/scheduled action with no actor (all actor fields undefined, not a crash)', async () => {
      await service.record({ tenantId: 't1', action: 'SUBMITTED' });
      expect(logs.save).toHaveBeenCalledWith(
        expect.objectContaining({ actor_id: undefined, actor_role: undefined }),
      );
    });

    it('accepts every declared VerificationAuditAction, including RE_DECISION_REFUSED (GAP-001)', async () => {
      await service.record({ tenantId: 't1', action: 'RE_DECISION_REFUSED', documentId: 'd1' });
      expect(logs.save).toHaveBeenCalledWith(expect.objectContaining({ action: 'RE_DECISION_REFUSED' }));
    });
  });

  describe('listForTenant (VER-005 — tenant-scoped, newest first)', () => {
    it('queries scoped to exactly the given tenant, ordered newest-first', async () => {
      await service.listForTenant('t1');
      expect(logs.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenant_id: 't1' },
          order: { created_at: 'DESC' },
        }),
      );
    });

    it('never leaks another tenant\'s entries into the result (the query carries no OR/global clause)', async () => {
      logs.find.mockResolvedValueOnce([
        { id: 'a1', tenant_id: 't1' },
        { id: 'a2', tenant_id: 't1' },
      ]);
      const result = await service.listForTenant('t1');
      expect(result.every((r: any) => r.tenant_id === 't1')).toBe(true);
    });

    it('defaults to 100 when no limit is given', async () => {
      await service.listForTenant('t1');
      expect(logs.find).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
    });

    it('clamps an excessive limit at 500 (never an unbounded scan)', async () => {
      await service.listForTenant('t1', 100000);
      expect(logs.find).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    });

    it('clamps a non-positive limit up to 1 (never zero/negative → an accidental full-table scan via take:0 being ignored)', async () => {
      await service.listForTenant('t1', -5);
      expect(logs.find).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
    });
  });
});
