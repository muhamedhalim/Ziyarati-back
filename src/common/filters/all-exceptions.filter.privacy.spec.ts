import {
  BadRequestException,
  HttpStatus,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { CANARY, leakedCanaries } from '../../../test/utils/log-canaries';
import { StructuredLogger } from '../logging/structured-logger';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * LSA-06 / LSA-07 / LSA-08 regressions, checked on the FINAL serialized log
 * line (the real StructuredLogger), not on the object handed to it. Synthetic
 * canaries only (test/utils/log-canaries.ts).
 */
describe('AllExceptionsFilter — privacy of the error log line', () => {
  let lines: string[];
  let request: any;
  let host: any;
  const filter = new AllExceptionsFilter();

  beforeEach(() => {
    lines = [];
    Logger.overrideLogger(
      new StructuredLogger({
        role: 'api',
        env: { NODE_ENV: 'production' },
        destination: { write: (s: string) => void lines.push(s) },
      }),
    );
    request = {
      requestId: 'req-priv',
      method: 'GET',
      originalUrl: '/api/v1/customers',
      baseUrl: '/api/v1',
      route: { path: '/customers' },
      ip: '203.0.113.77',
      user: { id: 'u1', tenantId: 't1' },
      body: {},
    };
    const json = jest.fn();
    host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          status: jest.fn().mockReturnValue({ json }),
          setHeader: jest.fn(),
          getHeader: jest.fn().mockReturnValue(undefined),
        }),
      }),
    };
  });

  afterEach(() => Logger.overrideLogger(['error']));

  const line = () => {
    expect(lines).toHaveLength(1);
    return lines[0];
  };
  const record = () => JSON.parse(line()) as Record<string, any>;

  it('query-string VALUES (name, guardian, visit reason, phones — raw and URL-encoded) never reach the log; names do', () => {
    const q = new URLSearchParams({
      name: CANARY.nameAr,
      guardian: CANARY.guardian,
      reason: CANARY.appointmentReason,
      mobile: CANARY.phoneIntl,
      patient: CANARY.nameEn,
      page: '2',
    }).toString();
    request.originalUrl = `/api/v1/customers?${q}&search=${encodeURIComponent(CANARY.nationalId)}`;
    filter.catch(new BadRequestException('page must be a number'), host);

    expect(leakedCanaries(line())).toEqual([]);
    expect(record()).toMatchObject({
      route: '/api/v1/customers',
      query_keys: [
        'guardian',
        'mobile',
        'name',
        'page',
        'patient',
        'reason',
        'search',
      ],
      status: 400,
    });
    expect(record().path).toBeUndefined();
  });

  it('path parameters (phone, name) never reach the log — only the route template', () => {
    request.route = { path: '/customers/by-phone/:phone' };
    request.originalUrl = `/api/v1/customers/by-phone/${encodeURIComponent(CANARY.phoneIntl)}`;
    filter.catch(new NotFoundException('Customer not found'), host);
    expect(leakedCanaries(line())).toEqual([]);
    expect(record().route).toBe('/api/v1/customers/by-phone/:phone');

    lines.length = 0;
    request.originalUrl = `/api/v1/customers/by-phone/${encodeURIComponent(CANARY.nameEn)}`;
    filter.catch(new NotFoundException('Customer not found'), host);
    expect(leakedCanaries(line())).toEqual([]);
  });

  it('unmatched 404: Nest\'s "Cannot GET <raw url>" message is reduced to method + route marker', () => {
    request.route = undefined;
    request.baseUrl = '';
    const raw = `/api/v1/no-such-route/${encodeURIComponent(CANARY.nameAr)}?q=${encodeURIComponent(CANARY.clinicalNote)}&guardian=${encodeURIComponent(CANARY.guardian)}`;
    request.originalUrl = raw;
    filter.catch(new NotFoundException(`Cannot GET ${raw}`), host);

    expect(leakedCanaries(line())).toEqual([]);
    expect(record()).toMatchObject({
      route: 'unmatched',
      message: 'Cannot GET unmatched',
      query_keys: ['guardian', 'q'],
    });
  });

  it('attacker-chosen query KEYS cannot smuggle values', () => {
    request.originalUrl = `/api/v1/customers?${encodeURIComponent(CANARY.nameEn)}=1&${encodeURIComponent(CANARY.phoneAscii)}&ok=1`;
    filter.catch(new BadRequestException('bad'), host);
    expect(leakedCanaries(line())).toEqual([]);
    expect(record().query_keys).toEqual(['[key]', 'ok']);
  });

  it('LSA-07: body_shape carries no numeric value and no user-chosen key', () => {
    request.method = 'POST';
    request.body = {
      mobile: 966599000119,
      vitals: { weight: 83.4, systolic: 151 },
      answers: { [CANARY.symptom]: true, [CANARY.nameEn]: 'x' },
    };
    filter.catch(new BadRequestException('validation failed'), host);
    const l = line();
    expect(leakedCanaries(l)).toEqual([]);
    for (const v of ['966599000119', '83.4', '151']) expect(l).not.toContain(v);
  });

  it('LSA-08: a security event carries the /24 network, never the full client address', () => {
    request.route = { path: '/auth/me' };
    filter.catch(new UnauthorizedException(), host);
    const r = record();
    expect(r.event).toBe('auth.authentication.failed');
    expect(r.client_ip).toBe('203.0.113.0');
    expect(line()).not.toContain(CANARY.ipv4);
  });

  it('keeps the safe diagnostics: request id, route, status, code, event', () => {
    filter.catch(new BadRequestException('bad'), host);
    expect(record()).toMatchObject({
      request_id: 'req-priv',
      route: '/api/v1/customers',
      status: HttpStatus.BAD_REQUEST,
      event: 'http.request.rejected',
      user_id: 'u1',
      tenant_id: 't1',
    });
    expect(typeof record().code).toBe('string');
  });
});
