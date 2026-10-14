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

  it('honours an incoming machine-generated X-Request-Id for cross-service tracing', () => {
    const upstream = 'gw-3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab';
    const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: upstream });
    requestContext(req, res, next);
    expect(req.requestId).toBe(upstream);
  });

  // LSA-09: a chosen word or number is not a correlation id — it would be
  // written verbatim into every log line of the request.
  it.each(['upstream-id', '0599000111', '%2B966599000112', 'Zqxcanary.Patientname', 'a'.repeat(128)])(
    'replaces a caller-chosen, non-generated id: %j',
    (value) => {
      const { req, res, next } = buildReqRes({ [REQUEST_ID_HEADER]: value });
      requestContext(req, res, next);
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

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
    const id128 = 'a1'.repeat(64);
    const ok = buildReqRes({ [REQUEST_ID_HEADER]: id128 });
    requestContext(ok.req, ok.res, ok.next);
    expect(ok.req.requestId).toBe(id128);
    const bad = buildReqRes({ [REQUEST_ID_HEADER]: `${id128}b` });
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
    for (const v of ['req_01HZXQ8V7K2M4N6P8R0T', '3f2b8c1e-aaaa-bbbb-cccc-1234567890ab', 'trace.4bf92f3577b34da6a3ce929d0e0e4736']) {
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
