import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';

import { classifyFailure } from '../filters/all-exceptions.filter';
import { formatClientIp } from './http-access-log';
import { startHeartbeat } from './heartbeat';
import { resolveLogConfig } from './log-config';
import { ObservabilityEventsListener } from './observability-events.listener';
import { installFatalHandlers } from './process-handlers';
import { StructuredLogger } from './structured-logger';

function capture(
  env: NodeJS.ProcessEnv = { NODE_ENV: 'production', LOG_LEVEL: 'debug' },
) {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    role: 'api',
    env,
    destination: { write: (s: string) => void lines.push(s) },
  });
  return {
    logger,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, any>),
  };
}

describe('resolveLogConfig', () => {
  it('production: json, info, ziyaratech-<role>', () => {
    expect(
      resolveLogConfig('worker', { NODE_ENV: 'production' }),
    ).toMatchObject({
      service: 'ziyaratech-worker',
      env: 'production',
      level: 'info',
      format: 'json',
    });
  });

  it('forces json in deployed environments even when pretty is requested', () => {
    expect(
      resolveLogConfig('api', {
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        LOG_FORMAT: 'pretty',
      }).format,
    ).toBe('json');
  });

  it('local development: pretty, debug', () => {
    expect(resolveLogConfig('api', {})).toMatchObject({
      env: 'development',
      level: 'debug',
      format: 'pretty',
    });
  });

  it('APP_VERSION wins over APP_REVISION; invalid values fall back explicitly', () => {
    expect(
      resolveLogConfig('api', { APP_VERSION: '1.4.2', APP_REVISION: 'abcdef1' })
        .version,
    ).toBe('1.4.2');
    expect(resolveLogConfig('api', { APP_REVISION: 'ABCDEF1' }).version).toBe(
      'abcdef1',
    );
    expect(resolveLogConfig('api', { APP_VERSION: '<script>' }).version).toBe(
      'unknown',
    );
    expect(resolveLogConfig('api', { LOG_LEVEL: 'loud' }).level).toBe('debug');
  });
});

describe('installFatalHandlers', () => {
  it('logs ONE fatal line with the stack, runs the graceful shutdown, then exits 1', async () => {
    const { logger, records } = capture();
    const target = new EventEmitter();
    const exit = jest.fn();
    const shutdown = jest.fn().mockResolvedValue(undefined);
    installFatalHandlers({ logger, shutdown, exit, target: target as any });

    target.emit('uncaughtException', new Error('kaboom'), 'uncaughtException');
    await new Promise((r) => setImmediate(r));

    const fatal = records().filter((r) => r.level === 'fatal');
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({
      event: 'process.uncaught_exception',
      origin: 'uncaughtException',
    });
    expect(fatal[0].error.stack).toContain('Error: kaboom');
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('classifies an unhandled rejection, and exits even if shutdown hangs', async () => {
    jest.useFakeTimers();
    try {
      const { logger, records } = capture();
      const target = new EventEmitter();
      const exit = jest.fn();
      installFatalHandlers({
        logger,
        shutdown: () => new Promise(() => undefined),
        exit,
        timeoutMs: 1000,
        target: target as any,
      });
      target.emit(
        'uncaughtException',
        'not even an Error',
        'unhandledRejection',
      );
      expect(records()[0].event).toBe('process.unhandled_rejection');
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('exits immediately on a second failure during shutdown', () => {
    const { logger } = capture();
    const target = new EventEmitter();
    const exit = jest.fn();
    installFatalHandlers({
      logger,
      shutdown: () => new Promise(() => undefined),
      exit,
      target: target as any,
    });
    target.emit('uncaughtException', new Error('first'));
    target.emit('uncaughtException', new Error('second'));
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('classifyFailure (exception filter event names)', () => {
  it.each([
    [401, 'POST', '/api/v1/auth/login', 'auth.login.failed', 'warn'],
    [429, 'POST', '/api/v1/auth/login', 'auth.login.failed', 'warn'],
    [401, 'POST', '/api/v1/auth/refresh', 'auth.refresh.failed', 'warn'],
    [401, 'GET', '/api/v1/customers', 'auth.authentication.failed', 'warn'],
    [403, 'GET', '/api/v1/customers', 'auth.authorization.denied', 'warn'],
    [429, 'GET', '/api/v1/customers', 'http.rate_limited', 'warn'],
    [409, 'POST', '/api/v1/appointments', 'appointment.booking.failed', 'warn'],
    [
      500,
      'POST',
      '/api/v1/public/booking/confirm',
      'appointment.booking.failed',
      'error',
    ],
    [
      502,
      'POST',
      '/api/v1/payments/webhooks/tap',
      'payment.webhook.failed',
      'error',
    ],
    [
      400,
      'POST',
      '/api/v1/payments/:id/refund',
      'payment.processing.failed',
      'warn',
    ],
    [
      500,
      'POST',
      '/api/v1/whatsapp/webhooks/events',
      'webhook.processing.failed',
      'error',
    ],
    [500, 'GET', '/api/v1/customers', 'http.request.failed', 'error'],
    [404, 'GET', 'unmatched', 'http.request.rejected', 'info'],
    [400, 'GET', '/api/v1/customers', 'http.request.rejected', 'warn'],
  ])('%i %s %s → %s (%s)', (status, method, route, event, level) => {
    expect(classifyFailure(status, method, route)).toMatchObject({
      event,
      level,
    });
  });

  it('a 5xx on the login route is a server failure, not a failed login', () => {
    expect(classifyFailure(500, 'POST', '/api/v1/auth/login').event).toBe(
      'http.request.failed',
    );
  });
});

describe('formatClientIp', () => {
  it.each([
    ['203.0.113.77', 'full', '203.0.113.77'],
    ['203.0.113.77', 'truncated', '203.0.113.0'],
    ['::ffff:198.51.100.9', 'truncated', '198.51.100.0'],
    ['2001:db8::1', 'truncated', '2001:db8:0::/48'],
    ['2001:db8:abcd:12::1', 'truncated', '2001:db8:abcd::/48'],
    ['203.0.113.77', 'off', undefined],
    ['not-an-ip\r\n', 'full', undefined],
    [undefined, 'full', undefined],
  ] as const)('%s (%s) → %s', (raw, mode, expected) => {
    expect(formatClientIp(raw, mode)).toBe(expected);
  });
});

describe('ObservabilityEventsListener', () => {
  it('logs committed transitions with ids only — never the free-text cancellation reason', () => {
    const { logger, records } = capture();
    Logger.overrideLogger(logger);
    try {
      const l = new ObservabilityEventsListener();
      l.onAppointmentCreated({
        tenantId: 't1',
        appointmentId: 'a1',
        customerId: 'c1',
        staffId: 's1',
        branchId: 'b1',
        startAt: new Date('2026-10-20T09:00:00Z'),
      } as any);
      l.onAppointmentCancelled({
        tenantId: 't1',
        appointmentId: 'a1',
        customerId: 'c1',
        reason: 'patient has a fever (private)',
      } as any);
      l.onPaymentFailed({
        tenantId: 't1',
        paymentId: 'p1',
        customerId: 'c1',
      } as any);
    } finally {
      Logger.overrideLogger(['error']);
    }
    const rs = records();
    expect(rs.map((r) => [r.event, r.level])).toEqual([
      ['appointment.booking.succeeded', 'info'],
      ['appointment.status.changed', 'info'],
      ['payment.state.changed', 'warn'],
    ]);
    expect(rs[0]).toMatchObject({
      tenant_id: 't1',
      appointment_id: 'a1',
      starts_at: '2026-10-20T09:00:00.000Z',
    });
    expect(JSON.stringify(rs)).not.toContain('fever');
    expect(JSON.stringify(rs)).not.toContain('c1'); // customer ids are not needed for diagnosis
  });

  it('swallows its own failures so it can never break a consumer chain', () => {
    const l = new ObservabilityEventsListener();
    (l as any).logger = {
      log: () => {
        throw new Error('logger down');
      },
    };
    expect(() =>
      l.onAppointmentCreated({ tenantId: 't', appointmentId: 'a' } as any),
    ).not.toThrow();
  });
});

describe('startHeartbeat', () => {
  it('emits app.heartbeat on the interval and stops cleanly', () => {
    jest.useFakeTimers();
    try {
      const { logger, records } = capture();
      const stop = startHeartbeat(logger, {
        LOG_HEARTBEAT_INTERVAL_MS: '1000',
      });
      jest.advanceTimersByTime(3000);
      stop();
      jest.advanceTimersByTime(3000);
      const beats = records().filter((r) => r.event === 'app.heartbeat');
      expect(beats).toHaveLength(3);
      expect(beats[0]).toMatchObject({ level: 'info' });
      expect(typeof beats[0].rss_mb).toBe('number');
    } finally {
      jest.useRealTimers();
    }
  });

  it('is disabled by LOG_HEARTBEAT_INTERVAL_MS=0', () => {
    jest.useFakeTimers();
    try {
      const { logger, records } = capture();
      startHeartbeat(logger, { LOG_HEARTBEAT_INTERVAL_MS: '0' });
      jest.advanceTimersByTime(120_000);
      expect(records()).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
