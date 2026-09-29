import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCode } from '../common/errors';
import {
  DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
  INBOUND_EVENTS,
  INBOUND_HEADER,
  WEBHOOK_SIGNATURE_SCHEME,
} from '../modules/integration-platform/integration-platform.constants';
import {
  computeInboundSignature,
  verifyInboundSignature,
} from '../modules/integration-platform/inbound/inbound-signature';
import { EXTERNAL_WRITABLE_FIELDS } from '../modules/integration-platform/write/source-of-truth';
import { TENANT_GRANTABLE_SCOPES } from '../modules/platform/integration-scopes.constants';
import {
  WEBHOOK_EVENTS,
  WEBHOOK_HEADER,
  computeWebhookSignature,
} from '../modules/platform/webhook.constants';
import {
  INTEGRATION_API_GUIDE,
  INTEGRATION_MAX_BODY_BYTES,
} from './integration-api-guide';

/**
 * The partner guide is a CONTRACT. These tests keep it honest: the code samples
 * it hands to a partner are executed against the platform's own verifiers, and
 * the values it states are compared to the constants the runtime reads.
 */

/** The n-th fenced ```js block of the guide. */
function jsBlock(n: number): string {
  const blocks = [...INTEGRATION_API_GUIDE.matchAll(/```js\n([\s\S]*?)```/g)];
  const block = blocks[n]?.[1];
  if (!block) throw new Error(`guide has no js block #${n}`);
  return block;
}

describe('integration API guide — executable samples', () => {
  it('the inbound signing sample produces a MAC the platform verifies under the default scheme', () => {
    const secret = 'whsec_sample_secret';
    const run = new Function(
      'require',
      'SIGNING_SECRET',
      `${jsBlock(0)}\nreturn { body, ts, eventId, eventType, mac };`,
    ) as (
      req: NodeRequire,
      secret: string,
    ) => {
      body: string;
      ts: string;
      eventId: string;
      eventType: string;
      mac: string;
    };
    const out = run(require, secret);

    expect(DEFAULT_WEBHOOK_SIGNATURE_SCHEME).toBe(
      WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2,
    );
    const meta = { eventId: out.eventId, eventType: out.eventType };
    expect(
      verifyInboundSignature(
        DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
        secret,
        out.ts,
        out.body,
        `sha256=${out.mac}`,
        meta,
      ),
    ).toBe(true);
    // ...and it equals the platform's own computation byte for byte.
    expect(`sha256=${out.mac}`).toBe(
      computeInboundSignature(
        DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
        secret,
        out.ts,
        out.body,
        meta,
      ),
    );
    // A different event id must NOT verify — the id really is signed.
    expect(
      verifyInboundSignature(
        DEFAULT_WEBHOOK_SIGNATURE_SCHEME,
        secret,
        out.ts,
        out.body,
        `sha256=${out.mac}`,
        { ...meta, eventId: 'another-id' },
      ),
    ).toBe(false);
  });

  it('the outbound verification sample accepts a real signature and rejects tampering and staleness', () => {
    const verify = new Function(
      'require',
      'Date',
      `${jsBlock(1)}\nreturn verify;`,
    ) as (
      req: NodeRequire,
      date: DateConstructor,
    ) => (
      raw: string,
      headers: Record<string, string>,
      secret: string,
    ) => boolean;
    const verifyFn = verify(require, Date);

    const secret = 'whsec_outbound';
    const body = JSON.stringify({ appointmentId: 'a1', customerId: 'c1' });
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      'x-webhook-timestamp': String(ts),
      'x-webhook-signature': computeWebhookSignature(secret, ts, body),
    };

    expect(verifyFn(body, headers, secret)).toBe(true);
    expect(verifyFn(`${body} `, headers, secret)).toBe(false);
    expect(verifyFn(body, headers, 'whsec_other')).toBe(false);

    const staleTs = ts - 3_600;
    expect(
      verifyFn(
        body,
        {
          'x-webhook-timestamp': String(staleTs),
          'x-webhook-signature': computeWebhookSignature(secret, staleTs, body),
        },
        secret,
      ),
    ).toBe(false);
  });

  it('documents the v2 signing string exactly as the platform builds it', () => {
    // newline-joined, in this order
    const mac = createHmac('sha256', 's')
      .update('1\nid\nevt\nbody')
      .digest('hex');
    expect(`sha256=${mac}`).toBe(
      computeInboundSignature(
        WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED_V2,
        's',
        '1',
        'body',
        {
          eventId: 'id',
          eventType: 'evt',
        },
      ),
    );
    expect(INTEGRATION_API_GUIDE).toContain(
      'timestamp\\neventId\\neventType\\nrawBody',
    );
  });
});

describe('integration API guide — shareable markdown copy', () => {
  // The API reference is off by default in production, so partners also need a
  // file they can be sent. It is GENERATED from the constant, never hand-edited:
  //   UPDATE_PARTNER_GUIDE=1 npx jest src/config/integration-api-guide.spec.ts
  const file = join(__dirname, '..', '..', 'docs', 'PARTNER_INTEGRATION_GUIDE.md');
  const rendered = `# Ziyarati Integration API — partner guide

> Generated from \`src/config/integration-api-guide.ts\` — do not edit by hand.
> \`<api-host>\` is the API address your Ziyarati contact gives you.

${INTEGRATION_API_GUIDE}
`;

  it('docs/PARTNER_INTEGRATION_GUIDE.md is in sync with the guide served at /docs/integrations', () => {
    if (process.env.UPDATE_PARTNER_GUIDE === '1') writeFileSync(file, rendered);
    const onDisk = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(rendered);
  });
});

describe('integration API guide — stated facts match the runtime', () => {
  it('names every header, event and scheme the runtime uses', () => {
    for (const h of Object.values(INBOUND_HEADER))
      expect(INTEGRATION_API_GUIDE).toContain(h);
    for (const h of Object.values(WEBHOOK_HEADER))
      expect(INTEGRATION_API_GUIDE).toContain(h);
    for (const e of INBOUND_EVENTS) expect(INTEGRATION_API_GUIDE).toContain(e);
    for (const e of WEBHOOK_EVENTS) expect(INTEGRATION_API_GUIDE).toContain(e);
    expect(INTEGRATION_API_GUIDE).toContain(DEFAULT_WEBHOOK_SIGNATURE_SCHEME);
    expect(INTEGRATION_API_GUIDE).toContain(
      WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_TIMESTAMPED,
    );
    expect(INTEGRATION_API_GUIDE).toContain(
      WEBHOOK_SIGNATURE_SCHEME.HMAC_SHA256_BODY,
    );
  });

  it('lists the exact writable field names per resource', () => {
    for (const fields of Object.values(EXTERNAL_WRITABLE_FIELDS)) {
      for (const f of fields)
        expect(INTEGRATION_API_GUIDE).toContain(`\`${f}\``);
    }
  });

  it('describes every tenant-grantable scope family', () => {
    for (const scope of TENANT_GRANTABLE_SCOPES) {
      const [, resource, verb] = scope.split('.'); // integration.<resource>.<verb>
      expect(INTEGRATION_API_GUIDE).toContain(`${resource}.${verb}`);
    }
  });

  it('only cites error codes that exist', () => {
    const cited = [
      ...INTEGRATION_API_GUIDE.matchAll(/`([A-Z][A-Z_]{3,})`/g),
    ].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(5);
    const known = new Set<string>(Object.values(ErrorCode));
    for (const code of cited) expect(known.has(code)).toBe(true);
  });

  it('states the body cap and the rate-limit back-off contract', () => {
    expect(INTEGRATION_MAX_BODY_BYTES).toBe(100 * 1024);
    expect(INTEGRATION_API_GUIDE).toContain(
      `${INTEGRATION_MAX_BODY_BYTES / 1024} KB`,
    );
    expect(INTEGRATION_API_GUIDE).toContain('Retry-After');
    expect(INTEGRATION_API_GUIDE).toContain('webhook.test');
  });

  it('does not repeat claims that were corrected', () => {
    expect(INTEGRATION_API_GUIDE).not.toMatch(/read-only api/i);
    // a suspended clinic is 403, not 401
    expect(INTEGRATION_API_GUIDE).not.toMatch(/401[^\n]*suspended/i);
  });
});
