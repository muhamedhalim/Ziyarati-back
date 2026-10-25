import { HttpException } from '@nestjs/common';

import { AppError, ErrorCode } from '../../../common/errors';
import { AiToolDispatchService } from './ai-tool-dispatch.service';

/**
 * Characterization of the dispatcher's ledger, confirmation gate and argument
 * helpers, driven through the service exactly as callers reach them. Written
 * before those parts were extracted into their own classes and kept as the
 * contract the extraction must not change.
 */
describe('AiToolDispatchService — ledger, confirmation gate, arg helpers (characterization)', () => {
  const CTX = { tenantId: 't1', aiConversationId: 'c1', turnId: 'turn-2' };

  function build(opts: {
    query?: jest.Mock;
    session?: Record<string, unknown>;
  } = {}) {
    const query = opts.query ?? jest.fn().mockResolvedValue([]);
    const dataSource = { query };
    const tenantContext = { getCorrelationId: jest.fn().mockReturnValue('corr-1') };
    const session = { pendingConfirmations: {}, ...(opts.session ?? {}) };
    const sessions = {
      get: jest.fn().mockImplementation(async () => session),
      patch: jest.fn().mockImplementation(async (_t: string, _c: string, p: any) => {
        Object.assign(session, p);
      }),
    };
    const args: unknown[] = new Array(18).fill({});
    args[9] = dataSource;
    args[15] = tenantContext;
    args[16] = sessions;
    const service = new (AiToolDispatchService as any)(...args);
    return { service: service as any, query, sessions, session, tenantContext };
  }

  describe('run (idempotent execution)', () => {
    const ok = { toolResult: { success: true, id: 1 }, resultJson: { r: 1 }, appointmentId: 'a1' };

    it('replays a SUCCEEDED call without executing', async () => {
      const { service } = build({
        query: jest.fn().mockResolvedValueOnce([{ id: 'x', status: 'SUCCEEDED', result: { success: true, v: 9 } }]),
      });
      const exec = jest.fn();
      await expect(service.run(CTX, 'book_appointment', 'k', {}, exec)).resolves.toEqual({
        success: true, v: 9, idempotentReplay: true,
      });
      expect(exec).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'EXECUTING'])('reports %s as in progress', async (status) => {
      const { service } = build({ query: jest.fn().mockResolvedValueOnce([{ id: 'x', status }]) });
      const exec = jest.fn();
      await expect(service.run(CTX, 't', 'k', {}, exec)).resolves.toEqual({
        success: false, error: 'A matching action is already in progress.',
      });
      expect(exec).not.toHaveBeenCalled();
    });

    it('hands back the recorded reason of a FAILED_PERMANENT call', async () => {
      const { service } = build({
        query: jest.fn().mockResolvedValueOnce([{ id: 'x', status: 'FAILED_PERMANENT', error: 'slot taken' }]),
      });
      await expect(service.run(CTX, 't', 'k', {}, jest.fn())).resolves.toEqual({ success: false, error: 'slot taken' });
    });

    it('asks for manual verification of any other prior outcome', async () => {
      const { service } = build({ query: jest.fn().mockResolvedValueOnce([{ id: 'x', status: 'UNKNOWN_OUTCOME' }]) });
      await expect(service.run(CTX, 't', 'k', {}, jest.fn())).resolves.toEqual({
        success: false,
        error: 'This action was already attempted and requires manual verification.',
      });
    });

    it('claims, executes, and records SUCCEEDED with the appointment id', async () => {
      const query = jest.fn()
        .mockResolvedValueOnce([]) // findByKey: none
        .mockResolvedValueOnce([{ id: 'row-1' }]) // claim
        .mockResolvedValue([]); // updates
      const { service } = build({ query });
      const exec = jest.fn().mockResolvedValue(ok);
      await expect(service.run(CTX, 'book_appointment', 'k', { a: 1 }, exec)).resolves.toEqual({ success: true, id: 1 });
      const sqls = query.mock.calls.map((c) => String(c[0]));
      expect(sqls[1]).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
      const claimParams = query.mock.calls[1][1];
      expect(claimParams.slice(0, 3)).toEqual(['t1', 'c1', null]);
      expect(claimParams[5]).toBe('k');
      expect(claimParams[6]).toBe('corr-1');
      expect(claimParams[8]).toBeNull(); // resource tenant: same as conversation tenant
      expect(sqls.some((s) => s.includes("status='EXECUTING'"))).toBe(true);
      expect(query).toHaveBeenLastCalledWith(expect.stringContaining("status='SUCCEEDED'"), ['row-1', '{"r":1}', 'a1']);
    });

    it('stores a differing resource tenant on the claim row', async () => {
      const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'row-1' }]).mockResolvedValue([]);
      const { service } = build({ query });
      await service.run(CTX, 't', 'k', {}, jest.fn().mockResolvedValue(ok), 'clinic-tenant');
      expect(query.mock.calls[1][1][8]).toBe('clinic-tenant');
    });

    it('on a lost claim race replays a SUCCEEDED winner, else reports in progress', async () => {
      const q1 = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'w', status: 'SUCCEEDED', result: { success: true } }]);
      await expect(build({ query: q1 }).service.run(CTX, 't', 'k', {}, jest.fn())).resolves.toEqual({
        success: true, idempotentReplay: true,
      });
      const q2 = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'w', status: 'EXECUTING' }]);
      await expect(build({ query: q2 }).service.run(CTX, 't', 'k', {}, jest.fn())).resolves.toEqual({
        success: false, error: 'A matching action is already in progress.',
      });
    });

    it('records an AppError as FAILED_PERMANENT with its message, anything else as UNKNOWN_OUTCOME', async () => {
      const q1 = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r' }]).mockResolvedValue([]);
      const e = new AppError(ErrorCode.CONFLICT, { message: 'slot taken' });
      await expect(build({ query: q1 }).service.run(CTX, 't', 'k', {}, jest.fn().mockRejectedValue(e))).resolves.toEqual({
        success: false, error: 'slot taken',
      });
      expect(q1).toHaveBeenLastCalledWith(expect.stringContaining('SET status=$2'), ['r', 'FAILED_PERMANENT', 'slot taken']);

      const q2 = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'r' }]).mockResolvedValue([]);
      const res = await build({ query: q2 }).service.run(CTX, 't', 'k', {}, jest.fn().mockRejectedValue(new Error('pg down')));
      expect(res).toEqual({ success: false, error: 'Unknown execution outcome; manual verification is required.' });
      expect(q2).toHaveBeenLastCalledWith(expect.any(String), ['r', 'UNKNOWN_OUTCOME', res.error]);
    });
  });

  describe('attempt records', () => {
    it('recordAttempt writes one non-claiming attempt row with actor null for a guest', async () => {
      const { service, query } = build();
      await service.recordAttempt(
        { ...CTX, actorUserId: 'guest-sub', principal: { guest: true } },
        'cancel_appointment', { x: 1 }, 'DENIED', 'nope',
      );
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('INSERT INTO ai_tool_calls');
      expect(params[3]).toBe('cancel_appointment');
      expect(params[5]).toBe('DENIED');
      expect(params[6]).toBe('nope');
      expect(params[7]).toMatch(/^attempt:cancel_appointment:[0-9a-f-]{36}$/);
      expect(params[9]).toBeNull();
    });

    it('records the staff actor id for a non-guest', async () => {
      const { service, query } = build();
      await service.recordAttempt({ ...CTX, actorUserId: 'u1' }, 't', {}, 'REFUSED', 'r');
      expect(query.mock.calls[0][1][9]).toBe('u1');
    });

    it('a ledger write failure never fails the attempt', async () => {
      const { service } = build({ query: jest.fn().mockRejectedValue(new Error('db')) });
      await expect(service.recordAttempt(CTX, 't', {}, 'DENIED', 'r')).resolves.toBeUndefined();
    });

    it('recordSessionAttempt records SUCCEEDED / REFUSED by result and REFUSED on a throw (then rethrows)', async () => {
      const a = build();
      await expect(a.service.recordSessionAttempt(CTX, 't', {}, async () => ({ success: true }))).resolves.toEqual({ success: true });
      expect(a.query.mock.calls[0][1][5]).toBe('SUCCEEDED');
      expect(a.query.mock.calls[0][1][6]).toBeNull();

      const b = build();
      await b.service.recordSessionAttempt(CTX, 't', {}, async () => ({ success: false, error: 'bad' }));
      expect(b.query.mock.calls[0][1].slice(5, 7)).toEqual(['REFUSED', 'bad']);

      const c = build();
      await expect(
        c.service.recordSessionAttempt(CTX, 't', {}, async () => { throw new AppError(ErrorCode.BAD_REQUEST, { message: 'boom' }); }),
      ).rejects.toThrow('boom');
      expect(c.query.mock.calls[0][1].slice(5, 7)).toEqual(['REFUSED', 'boom']);
    });
  });

  describe('confirmation gate', () => {
    const soon = () => new Date(Date.now() + 60_000).toISOString();

    it('none when nothing is pending', async () => {
      await expect(build().service.verifyConfirmation(CTX, 'k')).resolves.toBe('none');
    });

    it('issue records a proposal keyed to the turn; the same turn cannot confirm it', async () => {
      const { service, session } = build();
      const token = await service.issueConfirmation({ ...CTX, turnId: 'turn-1' }, 'k');
      expect(token).toMatch(/^[0-9a-f-]{36}$/);
      expect((session as any).pendingConfirmations.k.turnId).toBe('turn-1');
      await expect(service.verifyConfirmation({ ...CTX, turnId: 'turn-1' }, 'k')).resolves.toBe('same_turn');
      expect((session as any).pendingConfirmations.k).toBeDefined(); // left waiting
    });

    it('a LATER turn confirms and consumes it (one yes, one execution)', async () => {
      const { service, session } = build({ session: { pendingConfirmations: { k: { token: 't', expiresAt: soon(), turnId: 'turn-1' } } } });
      await expect(service.verifyConfirmation({ ...CTX, turnId: 'turn-2' }, 'k')).resolves.toBe('confirmed');
      expect((session as any).pendingConfirmations.k).toBeUndefined();
    });

    it('a call that cannot prove its turn is never confirmed', async () => {
      const { service } = build({ session: { pendingConfirmations: { k: { token: 't', expiresAt: soon(), turnId: 'turn-1' } } } });
      await expect(service.verifyConfirmation({ tenantId: 't1', aiConversationId: 'c1' }, 'k')).resolves.toBe('same_turn');
    });

    it('an expired proposal is dropped and reads as none', async () => {
      const { service, session } = build({
        session: { pendingConfirmations: { k: { token: 't', expiresAt: new Date(Date.now() - 1000).toISOString(), turnId: 'turn-1' } } },
      });
      await expect(service.verifyConfirmation(CTX, 'k')).resolves.toBe('none');
      expect((session as any).pendingConfirmations.k).toBeUndefined();
    });
  });

  describe('argument helpers', () => {
    const { service } = build();
    const UUID = '123e4567-e89b-12d3-a456-426614174000';

    it('str: non-blank strings only', () => {
      expect(service.str('  x ')).toBe('  x ');
      expect(service.str('   ')).toBeUndefined();
      expect(service.str(5)).toBeUndefined();
    });

    it('uuid: real UUIDs only, trimmed', () => {
      expect(service.uuid(` ${UUID} `)).toBe(UUID);
      expect(service.uuid('owner@inovra')).toBeUndefined();
      expect(service.uuid(undefined)).toBeUndefined();
    });

    it('badId names the field and source, leaks no schema', () => {
      const r = service.badId('clinicId', 'search_clinics');
      expect(r.success).toBe(false);
      expect(r.error).toContain('clinicId must be the UUID exactly as returned by search_clinics');
    });

    it('msg: AppError/HttpException text passes, anything else is replaced', () => {
      expect(service.msg(new AppError(ErrorCode.BAD_REQUEST, { message: 'visible' }))).toBe('visible');
      expect(service.msg(new HttpException('http visible', 400))).toBe('http visible');
      expect(service.msg(new Error('column "x" violates constraint'))).toBe('Tool execution failed.');
    });
  });
});
