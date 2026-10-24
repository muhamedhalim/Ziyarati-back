import { normalizeException } from './error-normalizer';

/**
 * body-parser rejects before any guard or controller runs, and its errors are plain `Error`s carrying an
 * HTTP `status`. A corrupt gzip/deflate/brotli body surfaces as the raw zlib error (status 400, expose
 * true, `code: Z_*` / `ERR_*`, negative `errno`, NO `type`) — it used to be answered with a 500
 * INTERNAL_ERROR, i.e. client-controlled input counted as a server fault.
 */
const bodyParserError = (props: Record<string, unknown>, message = 'x'): Error =>
  Object.assign(new Error(message), props);

describe('normalizeException — body-parser errors', () => {
  it('maps malformed JSON (entity.parse.failed) to 400 BAD_REQUEST', () => {
    const out = normalizeException(bodyParserError({ type: 'entity.parse.failed', status: 400 }), true);
    expect(out.statusCode).toBe(400);
    expect(out.code).toBe('BAD_REQUEST');
  });

  it('maps an over-sized body (entity.too.large) to 413', () => {
    const out = normalizeException(bodyParserError({ type: 'entity.too.large', status: 413 }), true);
    expect(out.statusCode).toBe(413);
    expect(out.message).toBe('Request body is too large');
  });

  it('maps an unsupported Content-Encoding (encoding.unsupported) to 415', () => {
    const out = normalizeException(bodyParserError({ type: 'encoding.unsupported', status: 415 }), true);
    expect(out.statusCode).toBe(415);
  });

  describe('corrupt compressed bodies', () => {
    it.each([
      ['gzip / deflate bad header', { code: 'Z_DATA_ERROR', errno: -3 }],
      ['truncated stream', { code: 'Z_BUF_ERROR', errno: -5 }],
      ['brotli failure', { code: 'ERR__ERROR_FORMAT_PADDING_2', errno: -15 }],
    ])('%s is a 400, not a 500', (_name, zlib) => {
      const out = normalizeException(
        bodyParserError({ ...zlib, status: 400, statusCode: 400, expose: true }, 'incorrect header check'),
        true,
      );
      expect(out.statusCode).toBe(400);
      expect(out.code).toBe('BAD_REQUEST');
      // Fixed text only — never the decoder's message, never request content.
      expect(out.message).toBe('Request body could not be parsed');
    });

    it.each([
      ['no expose marker (not produced by http-errors)', { code: 'Z_DATA_ERROR', errno: -3, status: 400 }],
      ['a 5xx status', { code: 'Z_DATA_ERROR', errno: -3, status: 500, expose: true }],
      ['a non-zlib code', { code: 'ECONNRESET', errno: -104, status: 400, expose: true }],
      ['a positive errno', { code: 'Z_DATA_ERROR', errno: 3, status: 400, expose: true }],
    ])('is NOT claimed as a client error when it has %s', (_name, props) => {
      const out = normalizeException(bodyParserError(props), true);
      expect(out.statusCode).toBe(500);
      expect(out.code).toBe('INTERNAL_ERROR');
    });
  });
});
