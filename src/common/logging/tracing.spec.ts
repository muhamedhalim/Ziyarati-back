import {
  SanitizingSpanProcessor,
  isTracingEnabled,
  redactPathForSpan,
  resolveTraceExporterUrl,
  sanitizeSpanForExport,
  startTracing,
} from './tracing';

/**
 * LSA-03 regressions. The 18 canaries are the ones the audit's isolated
 * export test (`otel-canary.cjs`) used — all synthetic.
 */
const C = {
  name: 'Zqxcanary Patientname',
  nameAr: 'زكريا كناري',
  phone: '0599000111',
  email: 'canary.patient@example.test',
  pathToken: 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34',
  queryToken: 'QTOKENcanary123456',
  diagnosis: 'CANARYDIAGNOSIS',
  cookie: 'CANARYCOOKIEVALUE123',
  bearer: 'CANARYBEARERVALUE123456',
  xff: '203.0.113.77',
  ua: 'CanaryAgent/9.9 (patient-device-CANARYUA)',
  sqlParam: 'CANARYSQLPARAM',
  sqlLiteral: 'CANARYSQLLITERAL',
  redisKey: 'otp:CANARYREDISKEY',
  redisVal: 'CANARYREDISVALUE',
  providerQuery: 'CANARYACCESSTOKEN',
  providerPath: '966599000111',
  tenant: '11111111-2222-4333-8444-555555555555',
};
// The tenant UUID is a record id, deliberately kept (not personal data).
const MUST_NOT_EXPORT = Object.entries(C).filter(([k]) => k !== 'tenant');

function found(text: string): string[] {
  const hay = text.toLowerCase();
  return MUST_NOT_EXPORT.filter(([, v]) =>
    [v, encodeURIComponent(v)].some((x) => hay.includes(x.toLowerCase())),
  ).map(([k]) => k);
}

/** Spans shaped like what instrumentation-http/express/pg/undici produce, carrying every canary. */
function hostileSpans() {
  const err = `Customer ${C.nameAr} ${C.phone} not found: ${C.diagnosis}`;
  return [
    {
      name: `GET /api/v1/public/pay/${C.pathToken}`,
      attributes: {
        'http.method': 'GET',
        'http.route': '/api/v1/public/pay/:token',
        'http.target': `/api/v1/public/pay/${C.pathToken}?token=${C.queryToken}`,
        'url.path': `/api/v1/public/pay/${C.pathToken}`,
        'url.query': `token=${C.queryToken}`,
        'url.full': `http://api.local/api/v1/public/pay/${C.pathToken}?token=${C.queryToken}`,
        'client.address': C.xff,
        'http.client_ip': C.xff,
        'user_agent.original': C.ua,
        'http.user_agent': C.ua,
        'http.request.header.cookie': [`zt_at=${C.cookie}`],
        'http.request.header.authorization': [`Bearer ${C.bearer}`],
        'http.request.header.x-tenant-id': [C.tenant],
        'http.status_code': 200,
      },
      events: [],
      status: { code: 0 },
    },
    {
      name: `request handler - /api/v1/customers`,
      attributes: {
        'http.route': '/api/v1/customers',
        'http.target': `/api/v1/customers?search=${encodeURIComponent(C.name)}&phone=${C.phone}&email=${encodeURIComponent(C.email)}`,
      },
      events: [
        {
          name: 'exception',
          attributes: {
            'exception.type': 'NotFoundException',
            'exception.message': err,
            'exception.stacktrace': `NotFoundException: ${err}\n    at handler (/app/x.js:1:1)`,
          },
        },
      ],
      status: { code: 2, message: err },
    },
    {
      name: 'pg.query:SELECT audit',
      attributes: {
        'db.system': 'postgresql',
        'db.query.text': `SELECT '${C.sqlLiteral}'::text AS lit WHERE x = $1`,
        'db.statement': `INSERT INTO canary_customers (phone, full_name) VALUES ('${C.phone}', '${C.name}')`,
      },
      events: [
        {
          name: 'exception',
          attributes: {
            'exception.type': 'error',
            'exception.message': `duplicate key value: Key (phone)=(${C.phone}) ${C.sqlParam}`,
          },
        },
      ],
      status: { code: 2, message: `Key (phone)=(${C.phone})` },
    },
    {
      name: 'POST',
      attributes: {
        'url.full': `http://127.0.0.1:9/v19.0/${C.providerPath}/messages?access_token=${C.providerQuery}`,
        'url.path': `/v19.0/${C.providerPath}/messages`,
        'http.url': `https://user:${C.bearer}@graph.example/v19.0/${C.providerPath}`,
        'server.address': 'graph.example',
      },
      events: [],
      status: { code: 0 },
    },
    {
      name: 'set',
      attributes: {
        'db.statement': 'set',
        note: `${C.redisKey} ${C.redisVal}`,
      },
      events: [],
      status: { code: 0 },
    },
  ];
}

describe('sanitizeSpanForExport (LSA-03)', () => {
  it('exports none of the 17 personal/secret canaries; keeps route, method, status, error TYPE', () => {
    const spans = hostileSpans();
    spans.forEach((s) => sanitizeSpanForExport(s as never));
    const exported = JSON.stringify(spans);

    expect(found(exported)).toEqual([]);

    const [server, express, pg, client] = spans as any[];
    expect(server.attributes['http.target']).toBe('/api/v1/public/pay/:token');
    expect(server.attributes['url.path']).toBe('/api/v1/public/pay/:token');
    expect(server.attributes['http.method']).toBe('GET');
    expect(server.attributes['http.status_code']).toBe(200);
    for (const k of [
      'client.address',
      'http.client_ip',
      'user_agent.original',
      'http.user_agent',
      'url.query',
      'http.request.header.cookie',
      'http.request.header.authorization',
    ])
      expect(server.attributes[k]).toBeUndefined();
    expect(server.name).toBe('GET /api/v1/public/pay/:param');

    expect(express.events[0].attributes).toEqual({
      'exception.type': 'NotFoundException',
    });
    expect(express.status).toEqual({ code: 2, message: 'NotFoundException' });

    expect(pg.attributes['db.query.text']).toBe(
      "SELECT '?'::text AS lit WHERE x = $1",
    );
    expect(client.attributes['url.full']).toBe(
      'http://127.0.0.1:9/v19.0/:param/messages',
    );
    expect(client.attributes['http.url']).toBe(
      'https://graph.example/v19.0/:param',
    );
    expect(client.attributes['server.address']).toBe('graph.example');
  });

  it('a path segment holding a phone, a name or an encoded value becomes :param; route words and UUIDs stay', () => {
    expect(
      redactPathForSpan(`/api/v1/customers/by-phone/%2B966599000112`),
    ).toBe('/api/v1/customers/by-phone/:param');
    expect(
      redactPathForSpan(
        `/api/v1/customers/by-name/${encodeURIComponent(C.nameAr)}`,
      ),
    ).toBe('/api/v1/customers/by-name/:param');
    expect(redactPathForSpan(`/api/v1/appointments/${C.tenant}/cancel`)).toBe(
      `/api/v1/appointments/${C.tenant}/cancel`,
    );
    expect(
      redactPathForSpan('/v20.0/1308840732301598/messages?access_token=x'),
    ).toBe('/v20.0/:param/messages');
  });

  it('the processor sanitizes before handing the span to the exporting processor', () => {
    const seen: string[] = [];
    const inner = {
      onStart: jest.fn(),
      onEnd: (s: unknown) => void seen.push(JSON.stringify(s)),
      forceFlush: jest.fn().mockResolvedValue(undefined),
      shutdown: jest.fn().mockResolvedValue(undefined),
    };
    const p = new SanitizingSpanProcessor(inner);
    hostileSpans().forEach((s) => p.onEnd(s));
    expect(found(seen.join('\n'))).toEqual([]);
  });

  it('drops attributes outside the semantic-convention allow-list; keeps a job span name', () => {
    const span = {
      name: 'job notifications/sendReminder',
      attributes: {
        patient_name: C.name,
        'app.note': C.diagnosis,
        'db.system': 'postgresql',
      },
      events: [],
      status: { code: 0 },
    };
    sanitizeSpanForExport(span as never);
    expect(span.attributes).toEqual({ 'db.system': 'postgresql' });
    expect(span.name).toBe('job notifications/sendReminder');
  });

  it('never throws on malformed spans', () => {
    expect(() => sanitizeSpanForExport({} as never)).not.toThrow();
    expect(() =>
      sanitizeSpanForExport({ attributes: null, events: null } as never),
    ).not.toThrow();
  });
});

describe('resolveTraceExporterUrl — deployed destination guard (LSA-03)', () => {
  const deployed = true;
  const allow = { OTEL_ALLOWED_COLLECTOR_HOSTS: 'otel.internal.ziyaratech' };

  it.each([
    [{}, 'no_endpoint'],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.internal.ziyaratech:4318',
        ...allow,
      },
      'insecure_transport',
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal.ziyaratech' },
      'no_collector_allowlist',
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.saas-vendor.example',
        ...allow,
      },
      'collector_not_allowlisted',
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT:
          'https://otel.internal.ziyaratech.attacker.example',
        ...allow,
      },
      'collector_not_allowlisted',
    ],
    [
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://u:p@otel.internal.ziyaratech',
        ...allow,
      },
      'credentials_in_url',
    ],
    [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'not a url', ...allow },
      'invalid_endpoint',
    ],
    [
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'ftp://otel.internal.ziyaratech',
        ...allow,
      },
      'unsupported_scheme',
    ],
  ])('refuses %j → %s', (env, reason) => {
    expect(resolveTraceExporterUrl(env as NodeJS.ProcessEnv, deployed)).toEqual(
      { refused: reason },
    );
  });

  it('accepts https to an allow-listed host (traces endpoint wins over the base)', () => {
    expect(
      resolveTraceExporterUrl(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal.ziyaratech/',
          ...allow,
        } as NodeJS.ProcessEnv,
        deployed,
      ),
    ).toEqual({ url: 'https://otel.internal.ziyaratech/v1/traces' });
    expect(
      resolveTraceExporterUrl(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.example',
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
            'https://OTEL.internal.ziyaratech/v1/traces',
          ...allow,
        } as NodeJS.ProcessEnv,
        deployed,
      ),
    ).toEqual({ url: 'https://otel.internal.ziyaratech/v1/traces' });
  });

  it('local development may use plain http (the observability stack)', () => {
    expect(
      resolveTraceExporterUrl(
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://tempo:4318',
        } as NodeJS.ProcessEnv,
        false,
      ),
    ).toEqual({ url: 'http://tempo:4318/v1/traces' });
  });
});

describe('startTracing — refuses in production with an unsafe destination', () => {
  it('does not start, and says why, for NODE_ENV=production + http endpoint', () => {
    const writes: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(((s: string) => void writes.push(s)) as never);
    try {
      startTracing('api', {
        OTEL_ENABLED: 'true',
        NODE_ENV: 'production',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.example:4318',
      });
    } finally {
      spy.mockRestore();
    }
    expect(isTracingEnabled()).toBe(false);
    expect(writes.join('')).toContain('tracing.start_refused');
    expect(writes.join('')).toContain('insecure_transport');
  });

  it('stays off when OTEL_ENABLED is unset (the deployed default)', () => {
    startTracing('api', { NODE_ENV: 'production' });
    expect(isTracingEnabled()).toBe(false);
  });
});
