import { MetaGraphClient } from './meta-graph.client';
import { MetaConfig } from './meta.config';
import { AppError } from '../../../common/errors';

/**
 * Template reads, deletes and failure classification. HTTP is mocked at the
 * `fetch` boundary; no real Meta call is made.
 */
describe('MetaGraphClient — template lifecycle', () => {
  let client: MetaGraphClient;
  let fetchMock: jest.Mock;

  const config = {
    graphVersion: 'v21.0',
    httpTimeoutMs: 10_000,
    graphUrl: (path: string) => `https://graph.facebook.com/v21.0/${path.replace(/^\//, '')}`,
  } as unknown as MetaConfig;

  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });
  const fail = (status: number, body: unknown) => ({
    ok: false,
    status,
    json: async () => body,
    headers: new Map(),
  });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new MetaGraphClient(config);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('listTemplates', () => {
    it('explicitly requests rejected_reason (it is NOT in Meta’s default fields)', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          data: [
            {
              id: '1',
              name: 'a',
              language: 'en_US',
              status: 'REJECTED',
              rejected_reason: 'INVALID_FORMAT',
              parameter_format: 'POSITIONAL',
            },
          ],
        }),
      );

      const out = await client.listTemplates('waba-1', 'tok');

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/waba-1/message_templates?limit=100');
      expect(url).toContain('fields=');
      expect(url).toContain('rejected_reason');
      expect(out[0]).toMatchObject({
        id: '1',
        rejectedReason: 'INVALID_FORMAT',
        parameterFormat: 'POSITIONAL',
      });
    });

    it('follows pagination cursors', async () => {
      fetchMock
        .mockResolvedValueOnce(
          ok({
            data: [{ id: '1', name: 'a', language: 'ar', status: 'APPROVED' }],
            paging: { next: 'https://x/next', cursors: { after: 'CUR1' } },
          }),
        )
        .mockResolvedValueOnce(ok({ data: [{ id: '2', name: 'b', language: 'ar', status: 'PENDING' }] }));

      const out = await client.listTemplates('waba-1', 'tok');

      expect(out.map((t) => t.id)).toEqual(['1', '2']);
      expect(fetchMock.mock.calls[1][0]).toContain('after=CUR1');
    });

    it('THROWS instead of returning a truncated list when the page cap is hit', async () => {
      fetchMock.mockImplementation(async () =>
        ok({
          data: [{ id: 'x', name: 'a', language: 'ar', status: 'APPROVED' }],
          paging: { next: 'https://x/next', cursors: { after: 'CUR' } },
        }),
      );
      await expect(client.listTemplates('waba-1', 'tok')).rejects.toBeInstanceOf(AppError);
      // Exactly the cap — never an unbounded loop on a third party's cursor.
      expect(fetchMock).toHaveBeenCalledTimes(20);
    });

    it('steps down to a smaller field list when Meta rejects a field (code 100) — and only then', async () => {
      fetchMock
        .mockResolvedValueOnce(fail(400, { error: { code: 100, message: '(#100) Tried accessing nonexisting field (parameter_format)' } }))
        .mockResolvedValueOnce(ok({ data: [{ id: '1', name: 'a', language: 'ar', status: 'APPROVED' }] }));

      const out = await client.listTemplates('waba-1', 'tok');

      expect(out).toHaveLength(1);
      expect(fetchMock.mock.calls[0][0]).toContain('parameter_format');
      expect(fetchMock.mock.calls[1][0]).not.toContain('parameter_format');
      expect(fetchMock.mock.calls[1][0]).toContain('rejected_reason');
    });

    it('does NOT retry other failures with a smaller field list (a 401 stays a 401)', async () => {
      fetchMock.mockResolvedValue(fail(401, { error: { code: 190, message: 'Invalid OAuth access token' } }));
      await expect(client.listTemplates('waba-1', 'tok')).rejects.toBeInstanceOf(AppError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTemplate', () => {
    it('reads one template by its Meta id', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({ id: '99', name: 'a', language: 'ar', status: 'APPROVED', category: 'UTILITY' }),
      );
      const t = await client.getTemplate('99', 'tok');
      expect(t).toMatchObject({ id: '99', status: 'APPROVED' });
      expect(fetchMock.mock.calls[0][0]).toContain('/99?fields=');
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
    });

    it('returns null ONLY for a definite "does not exist" (code 100 / subcode 33)', async () => {
      fetchMock.mockResolvedValueOnce(
        fail(400, { error: { code: 100, error_subcode: 33, message: 'Unsupported get request' } }),
      );
      await expect(client.getTemplate('99', 'tok')).resolves.toBeNull();
    });

    it('propagates a timeout rather than reporting the template gone', async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      await expect(client.getTemplate('99', 'tok')).rejects.toMatchObject({
        publicContext: { meta: { kind: 'timeout', retriable: true } },
      });
    });
  });

  describe('findTemplatesByName', () => {
    it('keeps only EXACT name matches (Meta’s name filter is a contains-search)', async () => {
      fetchMock.mockResolvedValueOnce(
        ok({
          data: [
            { id: '1', name: 'reminder', language: 'ar', status: 'APPROVED' },
            { id: '2', name: 'reminder_v2', language: 'ar', status: 'APPROVED' },
          ],
        }),
      );
      const out = await client.findTemplatesByName('waba-1', 'tok', 'reminder');
      expect(out.map((t) => t.id)).toEqual(['1']);
      expect(fetchMock.mock.calls[0][0]).toContain('name=reminder');
    });
  });

  describe('deleteTemplate', () => {
    it('DELETEs scoped by hsm_id AND name', async () => {
      fetchMock.mockResolvedValueOnce(ok({ success: true }));
      await client.deleteTemplate('waba-1', 'tok', '555', 'my_template');
      const [url, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe('DELETE');
      expect(url).toContain('/waba-1/message_templates?hsm_id=555&name=my_template');
      expect(init.headers.Authorization).toBe('Bearer tok');
    });

    it('fails when Meta answers success:false', async () => {
      fetchMock.mockResolvedValueOnce(ok({ success: false }));
      await expect(client.deleteTemplate('waba-1', 'tok', '555', 'n')).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('failure classification (what a caller may safely do next)', () => {
    const run = () =>
      client
        .createTemplate('waba-1', 'tok', {
          name: 'n',
          language: 'en',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'hi' }],
        })
        .catch((e) => e as AppError);

    it('a timeout is retriable and flagged as an ambiguous outcome kind', async () => {
      fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      const err = await run();
      expect(err.publicContext).toMatchObject({ meta: { kind: 'timeout', retriable: true } });
    });

    it('a network error is retriable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      const err = await run();
      expect(err.publicContext).toMatchObject({ meta: { kind: 'network', retriable: true } });
    });

    it('HTTP 429 and Meta throttling codes are rate_limited and retriable', async () => {
      fetchMock.mockResolvedValueOnce(fail(429, { error: { code: 80008, message: 'Rate limit hit' } }));
      const a = await run();
      expect(a.publicContext).toMatchObject({ meta: { kind: 'rate_limited', retriable: true, metaCode: 80008 } });

      fetchMock.mockResolvedValueOnce(fail(400, { error: { code: 4, message: 'Application request limit reached' } }));
      const b = await run();
      expect(b.publicContext).toMatchObject({ meta: { kind: 'rate_limited', retriable: true } });
    });

    it('a 5xx is unavailable and retriable', async () => {
      fetchMock.mockResolvedValueOnce(fail(503, { error: { code: 2, message: 'Service temporarily unavailable' } }));
      const err = await run();
      expect(err.publicContext).toMatchObject({ meta: { kind: 'unavailable', retriable: true } });
    });

    it('a 400 validation rejection is NOT retriable and keeps Meta’s own text', async () => {
      fetchMock.mockResolvedValueOnce(
        fail(400, {
          error: {
            code: 100,
            error_subcode: 2388293,
            message: 'Invalid parameter',
            error_user_title: 'Too many variables',
            error_user_msg:
              'This template has too many variables for its length. Reduce the number of variables or increase the message length.',
          },
        }),
      );
      const err = await run();
      expect(err.publicContext).toMatchObject({
        meta: {
          kind: 'rejected',
          retriable: false,
          metaCode: 100,
          metaSubcode: 2388293,
          metaMessage: 'Invalid parameter',
          metaTitle: 'Too many variables',
        },
      });
      expect((err.publicContext as any).meta.metaDetail).toMatch(/too many variables for its length/);
      expect(err.message).toMatch(/too many variables/i);
    });

    it('never forwards a token or email Meta echoed back', async () => {
      fetchMock.mockResolvedValueOnce(
        fail(400, {
          error: {
            code: 190,
            message: 'Invalid token Bearer EAAGm0PX4ZCpsBAKq8ZB1234567890abcdef for owner@clinic.com',
          },
        }),
      );
      const err = await run();
      const text = JSON.stringify(err.publicContext);
      expect(text).not.toContain('EAAGm0PX4ZCpsBAKq8ZB1234567890abcdef');
      expect(text).not.toContain('owner@clinic.com');
    });
  });
});
