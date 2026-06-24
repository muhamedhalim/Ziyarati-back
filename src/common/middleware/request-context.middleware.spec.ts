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

  it('RequestContextMiddleware.use delegates to the same logic', () => {
    const { req, res, next } = buildReqRes();
    new RequestContextMiddleware().use(req, res, next);
    expect(req.requestId).toEqual(expect.any(String));
    expect(next).toHaveBeenCalled();
  });
});
