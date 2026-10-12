import {
  requestContext,
  RequestContextMiddleware,
  REQUEST_ID_HEADER,
} from './request-context.middleware';

describe('requestContext middleware', () => {
  const buildReqRes = (headers: Record<string, unknown> = {}) => {
    const req = { headers } as any;
    const res = { setHeader: jest.fn() } as any;
    const next = jest.fn();
    return { req, res, next };
  };

  it('generates a request id when none is provided and echoes it', () => {
    const { req, res, next } = buildReqRes();
    requestContext(req, res, next);
    expect(req.requestId).toEqual(expect.any(String));
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    expect(next).toHaveBeenCalled();
  });

  it('honours an incoming X-Request-Id for cross-service tracing', () => {
    const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: 'upstream-id' });
    requestContext(req, res, next);
    expect(req.requestId).toBe('upstream-id');
  });

  it('generates a new id when the incoming header is blank', () => {
    const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: '   ' });
    requestContext(req, res, next);
    expect(req.requestId).not.toBe('   ');
    expect(req.requestId.length).toBeGreaterThan(0);
  });

  it('replaces an oversized id instead of echoing it', () => {
    const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: 'a'.repeat(2000) });
    requestContext(req, res, next);
    expect(req.requestId).not.toContain('aaaa');
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts exactly 128 chars, replaces 129', () => {
    const ok = buildReqRes({ [REQUEST_ID_HEADER]: 'a'.repeat(128) });
    requestContext(ok.req, ok.res, ok.next);
    expect(ok.req.requestId).toBe('a'.repeat(128));
    const bad = buildReqRes({ [REQUEST_ID_HEADER]: 'a'.repeat(129) });
    requestContext(bad.req, bad.res, bad.next);
    expect(bad.req.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(['has space', 'a\r\nSet-Cookie: x=1', '<script>', 'id/with/slash', 'ключ'])(
    'replaces an id with unsafe characters: %j',
    (value) => {
      const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: value });
      requestContext(req, res, next);
      expect(req.requestId).not.toBe(value);
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('keeps ids in the common correlation shapes', () => {
    for (const v of ['req_01HZX.abc:1-2', '3f2b8c1e-aaaa-bbbb-cccc-1234567890ab', 'trace.id_42']) {
      const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: v });
      requestContext(req, res, next);
      expect(req.requestId).toBe(v);
    }
  });

  it('RequestContextMiddleware.use delegates to the same logic', () => {
    const { req, res, next } = buildReqRes();
    new RequestContextMiddleware().use(req, res, next);
    expect(req.requestId).toEqual(expect.any(String));
    expect(next).toHaveBeenCalled();
  });
});
