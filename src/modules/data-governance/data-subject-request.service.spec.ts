import { ConfigService } from '@nestjs/config';

import { DataSubjectRequestService } from './data-subject-request.service';
import type { DataSubjectRequest } from '../../entities/Governance/DataSubjectRequest';

/**
 * Residency plan P13 — the request lifecycle. Collaborators are doubles; the
 * erasure and export themselves are covered against PostgreSQL elsewhere.
 */
const TENANT = 'tenant-1';
const USER = 'user-1';
const CUSTOMER = 'customer-1';

function build(opts: { dueDays?: string; customerExists?: boolean } = {}) {
  const rows = new Map<string, DataSubjectRequest>();
  let seq = 0;
  const repo = {
    create: (v: Partial<DataSubjectRequest>) =>
      ({ ...v }) as DataSubjectRequest,
    save: jest.fn(async (v: DataSubjectRequest) => {
      if (!v.id) v.id = `req-${(seq += 1)}`;
      rows.set(v.id, v);
      return v;
    }),
    findOne: jest.fn(
      async ({ where }: { where: { id: string; tenant_id: string } }) => {
        const r = rows.get(where.id);
        return r && r.tenant_id === where.tenant_id ? r : null;
      },
    ),
    findAndCount: jest.fn(async () => [[...rows.values()], rows.size]),
  };
  const query = jest
    .fn()
    .mockResolvedValue(
      opts.customerExists === false ? [] : [{ '?column?': 1 }],
    );
  const dataSource = { getRepository: () => repo, query };
  const config = new ConfigService(
    opts.dueDays ? { DSR_RESPONSE_DAYS: opts.dueDays } : {},
  );
  const exporter = {
    build: jest.fn().mockResolvedValue({
      counts: { identity: 1 },
      truncated: [],
      sections: {},
      subjectId: CUSTOMER,
      generatedAt: 'now',
    }),
  };
  const eraser = { erase: jest.fn() };
  const accessLog = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new DataSubjectRequestService(
    dataSource as never,
    config,
    exporter as never,
    eraser as never,
    accessLog as never,
  );
  return { svc, repo, rows, query, exporter, eraser, accessLog };
}

const input = (over: Record<string, unknown> = {}) => ({
  customerId: CUSTOMER,
  type: 'EXPORT' as const,
  channel: 'in_person',
  ...over,
});

describe('DataSubjectRequestService.create', () => {
  it('records the request as RECEIVED with no deadline unless one is configured', async () => {
    const { svc } = build();
    const r = await svc.create(TENANT, USER, input());
    expect(r).toMatchObject({
      tenant_id: TENANT,
      customer_id: CUSTOMER,
      status: 'RECEIVED',
      type: 'EXPORT',
      requested_by_user_id: USER,
    });
    // The legal period is a counsel input; it is never assumed.
    expect(r.due_at).toBeNull();
  });

  it('sets a deadline only from the configured number of days', async () => {
    const { svc } = build({ dueDays: '30' });
    const r = await svc.create(TENANT, USER, input());
    const days = (r.due_at!.getTime() - r.received_at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);
  });

  it('refuses a customer outside the clinic', async () => {
    const { svc, repo } = build({ customerExists: false });
    await expect(svc.create(TENANT, USER, input())).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
    });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it.each([
    ['a national id', 'ID is 1012345678'],
    ['an email', 'from sara@example.com'],
    ['a phone number', 'call 050 123 4567'],
    ['a card number', 'card 4111 1111 1111 1111'],
  ])(
    "refuses a note carrying %s — the trail must not hold the patient's data",
    async (_l, note) => {
      const { svc, repo } = build();
      await expect(
        svc.create(TENANT, USER, input({ note })),
      ).rejects.toMatchObject({
        message: expect.stringContaining('must not contain'),
      });
      expect(repo.save).not.toHaveBeenCalled();
    },
  );

  it('accepts a procedural note', async () => {
    const { svc } = build();
    await expect(
      svc.create(
        TENANT,
        USER,
        input({ note: 'Asked in person at reception, ID checked.' }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('DataSubjectRequestService lifecycle', () => {
  it('EXPORT builds the document, records the read, and closes the request with counts only', async () => {
    const { svc, accessLog, exporter } = build();
    const req = await svc.create(TENANT, USER, input());
    const out = await svc.fulfilExport(TENANT, USER, req.id);

    expect(exporter.build).toHaveBeenCalledWith(TENANT, CUSTOMER);
    expect(accessLog.record).toHaveBeenCalledWith(
      TENANT,
      CUSTOMER,
      USER,
      'export',
    );
    expect(out.request).toMatchObject({
      status: 'COMPLETED',
      handled_by_user_id: USER,
    });
    expect(out.request.outcome).toEqual({
      sections: { identity: 1 },
      truncated: [],
    });
    expect(out.request.completed_at).toBeInstanceOf(Date);
  });

  it('refuses the wrong type of action for a request', async () => {
    const { svc } = build();
    const req = await svc.create(TENANT, USER, input({ type: 'DELETION' }));
    await expect(svc.fulfilExport(TENANT, USER, req.id)).rejects.toMatchObject({
      message: expect.stringContaining('DELETION request'),
    });
  });

  it('will not act on a request that is already finished', async () => {
    const { svc } = build();
    const req = await svc.create(TENANT, USER, input());
    await svc.fulfilExport(TENANT, USER, req.id);
    await expect(svc.fulfilExport(TENANT, USER, req.id)).rejects.toMatchObject({
      message: expect.stringContaining('already completed'),
    });
  });

  it("cannot see or act on another clinic's request", async () => {
    const { svc } = build();
    const req = await svc.create(TENANT, USER, input());
    await expect(svc.get('other-tenant', req.id)).rejects.toMatchObject({
      message: expect.stringContaining('not found'),
    });
    await expect(
      svc.fulfilExport('other-tenant', USER, req.id),
    ).rejects.toMatchObject({ message: expect.stringContaining('not found') });
  });

  describe('DELETION', () => {
    const erased = (over: Record<string, unknown> = {}) => ({
      dryRun: false,
      status: 'COMPLETED',
      evidenceId: 'ev-1',
      report: { stores: [] },
      ...over,
    });

    it('passes the explicit clinical choice and the request id, links the evidence, and closes on COMPLETE', async () => {
      const { svc, eraser, accessLog } = build();
      eraser.erase.mockResolvedValue(erased());
      const req = await svc.create(TENANT, USER, input({ type: 'DELETION' }));
      const out = await svc.fulfilDeletion(TENANT, USER, req.id, {
        clinical: 'retain',
      });

      expect(eraser.erase).toHaveBeenCalledWith(TENANT, CUSTOMER, {
        clinical: 'retain',
        dryRun: undefined,
        requestId: req.id,
        performedByUserId: USER,
      });
      expect(out.request).toMatchObject({
        status: 'COMPLETED',
        evidence_id: 'ev-1',
      });
      expect(out.request.outcome).toEqual({
        clinical: 'retain',
        erasure: 'COMPLETED',
      });
      expect(accessLog.record).toHaveBeenCalledWith(
        TENANT,
        CUSTOMER,
        USER,
        'erasure',
      );
    });

    it('a dry run leaves the request OPEN and records nothing', async () => {
      const { svc, eraser, accessLog } = build();
      eraser.erase.mockResolvedValue(
        erased({ dryRun: true, evidenceId: undefined }),
      );
      const req = await svc.create(TENANT, USER, input({ type: 'DELETION' }));
      const out = await svc.fulfilDeletion(TENANT, USER, req.id, {
        clinical: 'erase',
        dryRun: true,
      });
      expect(out.request.status).toBe('RECEIVED');
      expect(accessLog.record).not.toHaveBeenCalled();
    });

    it('a PARTIAL erasure keeps the request IN_PROGRESS — it is not reported as done', async () => {
      const { svc, eraser } = build();
      eraser.erase.mockResolvedValue(erased({ status: 'PARTIAL' }));
      const req = await svc.create(TENANT, USER, input({ type: 'DELETION' }));
      const out = await svc.fulfilDeletion(TENANT, USER, req.id, {
        clinical: 'erase',
      });
      expect(out.request.status).toBe('IN_PROGRESS');
      expect(out.request.completed_at).toBeNull();
      expect(out.request.evidence_id).toBe('ev-1');
    });

    it('a PARTIAL request can be retried and then closed', async () => {
      const { svc, eraser } = build();
      eraser.erase
        .mockResolvedValueOnce(erased({ status: 'PARTIAL' }))
        .mockResolvedValueOnce(erased({ evidenceId: 'ev-2' }));
      const req = await svc.create(TENANT, USER, input({ type: 'DELETION' }));
      await svc.fulfilDeletion(TENANT, USER, req.id, { clinical: 'erase' });
      const second = await svc.fulfilDeletion(TENANT, USER, req.id, {
        clinical: 'erase',
      });
      expect(second.request).toMatchObject({
        status: 'COMPLETED',
        evidence_id: 'ev-2',
      });
    });
  });

  it('RESTRICTION applies the marketing opt-out only, and says what it did not do', async () => {
    const { svc, query } = build();
    const req = await svc.create(TENANT, USER, input({ type: 'RESTRICTION' }));
    const done = await svc.fulfilRestriction(TENANT, USER, req.id);

    const update = query.mock.calls
      .map((c) => String(c[0]))
      .find((q) => q.includes('UPDATE "customers"'))!;
    expect(update).toContain('"marketing_opt_in" = false');
    expect(update).toContain(`'dsr_restriction'`);
    expect(update).toContain('"tenantId" = $2');
    expect(done.status).toBe('COMPLETED');
    expect(done.outcome).toMatchObject({ applied: ['marketing_opt_out'] });
    expect(String(done.outcome?.notApplied)).toContain(
      'Operational processing',
    );
  });

  it('close() finishes a CORRECTION or records a refusal, and screens the note too', async () => {
    const { svc } = build();
    const req = await svc.create(TENANT, USER, input({ type: 'CORRECTION' }));
    await expect(
      svc.close(TENANT, USER, req.id, 'COMPLETED', 'email sara@example.com'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('must not contain'),
    });
    const done = await svc.close(
      TENANT,
      USER,
      req.id,
      'REJECTED',
      'Identity could not be verified.',
    );
    expect(done).toMatchObject({
      status: 'REJECTED',
      note: 'Identity could not be verified.',
    });
  });
});
