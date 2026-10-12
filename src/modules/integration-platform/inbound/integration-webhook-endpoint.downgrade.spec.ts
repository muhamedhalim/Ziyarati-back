import { IntegrationWebhookEndpointService } from './integration-webhook-endpoint.service';
import { WEBHOOK_SIGNATURE_SCHEME } from '../integration-platform.constants';
import { ErrorCode } from '../../../common/errors';

const V1 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED;
const BODY = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY;
const V2 = WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2;

function build(scheme: string) {
  const row = {
    id: 'ep-1',
    signature_scheme: scheme,
    allowed_events: ['customer.upserted'],
    tolerance_seconds: 300,
    status: 'active',
    secret_prefix: 'abc',
    accepted_count: 0,
    rejected_count: 0,
    connection: { id: 'c1' },
  };
  const repo = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn(async (x) => x),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const svc = new IntegrationWebhookEndpointService(repo as never, {} as never, {} as never, audit as never);
  return { svc, repo, row, audit };
}

describe('F13 — signature scheme is a one-way ratchet', () => {
  it.each([V1, BODY])('refuses moving a v2 endpoint down to %s (400) and leaves it unchanged', async (target) => {
    const t = build(V2);
    await expect(t.svc.update('t1', 'ep-1', { signatureScheme: target }, {})).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(t.repo.save).not.toHaveBeenCalled();
    expect(t.row.signature_scheme).toBe(V2);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('allows moving a legacy endpoint up to v2', async () => {
    const t = build(BODY);
    const view = await t.svc.update('t1', 'ep-1', { signatureScheme: V2 }, {});
    expect(view.signatureScheme).toBe(V2);
    expect(view.signatureSchemeDeprecated).toBe(false);
  });

  it('allows legacy → legacy and re-sending the same v2 scheme', async () => {
    const a = build(BODY);
    await expect(a.svc.update('t1', 'ep-1', { signatureScheme: V1 }, {})).resolves.toMatchObject({
      signatureScheme: V1,
      signatureSchemeDeprecated: true,
    });
    const b = build(V2);
    await expect(b.svc.update('t1', 'ep-1', { signatureScheme: V2 }, {})).resolves.toMatchObject({
      signatureScheme: V2,
    });
  });

  it('other updates on a v2 endpoint still work', async () => {
    const t = build(V2);
    await expect(t.svc.update('t1', 'ep-1', { toleranceSeconds: 120 }, {})).resolves.toMatchObject({
      toleranceSeconds: 120,
      signatureScheme: V2,
    });
  });
});
