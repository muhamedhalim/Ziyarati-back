import { MetaWhatsappProvider } from './meta-whatsapp.provider';
import { WhatsappAccountResolver } from '../routing/whatsapp-account.resolver';

/**
 * What actually goes to Meta for a TEMPLATE send. `fetch` is mocked — no
 * message is ever sent to anyone.
 */
describe('MetaWhatsappProvider — template parameters', () => {
  let provider: MetaWhatsappProvider;
  let fetchMock: jest.Mock;
  let resolver: { byId: jest.Mock };

  const base = {
    tenantId: 't1',
    accountId: 'acc-1',
    phoneNumberId: 'pid-1',
    to: '+966 50 000 0000',
    templateId: 'tpl-1',
    templateName: 'appointment_reminder',
    language: 'en_US',
  };

  const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.X' }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    resolver = {
      byId: jest.fn().mockResolvedValue({ id: 'acc-1', phoneNumberId: 'pid-1', accessToken: 'tok' }),
    };
    provider = new MetaWhatsappProvider(resolver as unknown as WhatsappAccountResolver);
  });

  afterEach(() => jest.restoreAllMocks());

  it('orders parameters by the TEMPLATE, not by the order the caller built the map', async () => {
    await provider.send({
      ...base,
      variables: { '2': 'Sunday 5:00 PM', '1': 'Sara' },
      templateParameters: ['1', '2'],
      parameterFormat: 'POSITIONAL',
    });

    expect(sentBody().template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Sara' },
          { type: 'text', text: 'Sunday 5:00 PM' },
        ],
      },
    ]);
  });

  it('with non-numeric keys, uses the declared order rather than insertion order', async () => {
    await provider.send({
      ...base,
      variables: { date: '12 Oct', name: 'Sara' }, // inserted date-first
      templateParameters: ['name', 'date'],
    });
    const params = sentBody().template.components[0].parameters.map((p: any) => p.text);
    expect(params).toEqual(['Sara', '12 Oct']);
  });

  it('sends ONLY the template’s parameters — extra keys cannot cause a count mismatch', async () => {
    await provider.send({
      ...base,
      variables: { '1': 'Sara', cancelUrl: 'https://x/cancel', rescheduleUrl: 'https://x/re' },
      templateParameters: ['1'],
    });
    expect(sentBody().template.components[0].parameters).toHaveLength(1);
  });

  it('fills NAMED templates by parameter_name', async () => {
    await provider.send({
      ...base,
      variables: { patient: 'Sara', when: 'Sunday' },
      templateParameters: ['patient', 'when'],
      parameterFormat: 'NAMED',
    });
    expect(sentBody().template.components[0].parameters).toEqual([
      { type: 'text', parameter_name: 'patient', text: 'Sara' },
      { type: 'text', parameter_name: 'when', text: 'Sunday' },
    ]);
  });

  it('sends no components for a template that declares no parameters', async () => {
    await provider.send({
      ...base,
      variables: { cancelUrl: 'https://x' },
      templateParameters: [],
    });
    expect(sentBody().template.components).toBeUndefined();
  });

  it('keeps the legacy behaviour for callers that pass no parameter list', async () => {
    await provider.send({ ...base, variables: { a: 'one', b: 'two' } });
    expect(sentBody().template.components[0].parameters.map((p: any) => p.text)).toEqual(['one', 'two']);
  });

  it('uses the template’s own language code and normalises the recipient', async () => {
    await provider.send({ ...base, templateParameters: [] });
    const body = sentBody();
    expect(body.template.language).toEqual({ code: 'en_US' });
    expect(body.to).toBe('966500000000');
  });

  it('resolves credentials per tenant+account and never puts the token in the body', async () => {
    await provider.send({ ...base, templateParameters: [] });
    expect(resolver.byId).toHaveBeenCalledWith('t1', 'acc-1');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(fetchMock.mock.calls[0][1].body).not.toContain('tok');
  });

  it('returns Meta’s error CODE so the caller can tell a paused template from a bad number', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 132015, message: 'Template is paused' } }),
    });
    const res = await provider.send({ ...base, templateParameters: [] });
    expect(res).toEqual({
      success: false,
      error: '400: Template is paused',
      errorCode: 132015,
    });
  });

  it('never throws on a timeout: it reports failure so the caller can reconcile', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(provider.send({ ...base, templateParameters: [] })).resolves.toEqual({
      success: false,
      error: 'Meta API timeout',
    });
  });
});
