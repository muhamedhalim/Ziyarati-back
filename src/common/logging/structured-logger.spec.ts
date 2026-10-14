import { Logger } from '@nestjs/common';

import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { runWithJobLogContext } from './log-context';
import { StructuredLogger } from './structured-logger';

/** A logger whose output is captured as parsed JSON records. */
function capture(
  env: NodeJS.ProcessEnv = { NODE_ENV: 'production', APP_REVISION: 'abc1234' },
) {
  const lines: string[] = [];
  const logger = new StructuredLogger({
    role: 'api',
    env,
    destination: { write: (s: string) => void lines.push(s) },
  });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, any>);
  return { logger, lines, records };
}

const ISO_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('StructuredLogger — schema', () => {
  it('writes one JSON object per line with every base field', () => {
    const { logger, lines, records } = capture();
    logger.log('hello world', 'Bootstrap');

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(lines[0].trimEnd().includes('\n')).toBe(false);
    const [r] = records();
    expect(r.timestamp).toMatch(ISO_MS_UTC);
    expect(r).toMatchObject({
      level: 'info',
      service: 'ziyaratech-api',
      env: 'production',
      version: 'abc1234',
      event: 'bootstrap.log',
      context: 'Bootstrap',
      message: 'hello world',
    });
    expect(typeof r.pid).toBe('number');
  });

  it('uses an explicit, valid event name and keeps structured fields', () => {
    const { logger, records } = capture();
    logger.warn({
      event: 'payment.state.changed',
      message: 'Payment failed',
      payment_id: 'p-1',
      state: 'failed',
    });
    expect(records()[0]).toMatchObject({
      level: 'warn',
      event: 'payment.state.changed',
      message: 'Payment failed',
      payment_id: 'p-1',
      state: 'failed',
    });
  });

  it('refuses a malformed event name (falls back to <context>.log)', () => {
    const { logger, records } = capture();
    logger.log({ event: 'Not An Event\n', message: 'x' }, 'Thing');
    expect(records()[0].event).toBe('thing.log');
  });

  it('never lets fields overwrite the base fields', () => {
    const { logger, records } = capture();
    logger.log({
      event: 'app.test.done',
      message: 'm',
      level: 'fatal',
      service: 'evil',
      timestamp: 'x',
      env: 'dev',
    });
    const r = records()[0];
    expect(r.level).toBe('info');
    expect(r.service).toBe('ziyaratech-api');
    expect(r.env).toBe('production');
    expect(r.timestamp).toMatch(ISO_MS_UTC);
    expect(r.data_level).toBe('fatal');
  });

  it('maps every Nest level onto the five schema levels', () => {
    const { logger, records } = capture({
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
    });
    logger.debug('d');
    logger.verbose('v');
    logger.log('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(records().map((r) => r.level)).toEqual([
      'debug',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
  });
});

describe('StructuredLogger — levels and config', () => {
  it('defaults to info in production (debug is dropped)', () => {
    const { logger, records } = capture({ NODE_ENV: 'production' });
    logger.debug('hidden');
    logger.log('shown');
    expect(records().map((r) => r.message)).toEqual(['shown']);
  });

  it('honours LOG_LEVEL', () => {
    const { logger, records } = capture({
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
    });
    logger.warn('hidden');
    logger.error('shown');
    expect(records().map((r) => r.message)).toEqual(['shown']);
  });

  it('defaults to debug in local development', () => {
    const { logger, records } = capture({ NODE_ENV: 'development' });
    logger.debug('shown');
    expect(records()).toHaveLength(1);
  });

  it('reports APP_ENV over NODE_ENV (staging runs NODE_ENV=production)', () => {
    const { logger, records } = capture({
      NODE_ENV: 'production',
      APP_ENV: 'staging',
    });
    logger.log('x');
    expect(records()[0].env).toBe('staging');
  });

  it('falls back to an explicit "unknown" version and a safe service name for bad values', () => {
    const { logger, records } = capture({
      NODE_ENV: 'production',
      APP_REVISION: 'not a sha; rm -rf',
      SERVICE_NAME: 'Evil Service\nname',
    });
    logger.log('x');
    expect(records()[0]).toMatchObject({
      version: 'unknown',
      service: 'ziyaratech-api',
    });
  });
});

describe('StructuredLogger — Nest Logger compatibility', () => {
  it("routes a plain `new Logger('Ctx')` call, with the stack Nest passes to error()", () => {
    const { logger, records } = capture();
    const nest = new Logger('QueueMonitor');
    const original = (Logger as any).staticInstanceRef;
    (Logger as any).staticInstanceRef = logger;
    try {
      nest.log('plain line');
      const err = new Error('boom');
      nest.error('it failed', err.stack);
      nest.error('no stack');
    } finally {
      (Logger as any).staticInstanceRef = original;
    }
    const [a, b, c] = records();
    expect(a).toMatchObject({
      event: 'queue_monitor.log',
      context: 'QueueMonitor',
      message: 'plain line',
    });
    expect(b.level).toBe('error');
    expect(b.error.stack).toContain('Error: boom');
    expect(c).toMatchObject({ level: 'error', message: 'no stack' });
    expect(c.error).toBeUndefined();
  });

  it('serializes an Error message argument with type, message and (error-level) stack', () => {
    const { logger, records } = capture();
    const err = Object.assign(new TypeError('bad input'), { code: 'E_BAD' });
    logger.error(err);
    logger.warn(new Error('warned'));
    const [e, w] = records();
    expect(e.error).toMatchObject({
      type: 'TypeError',
      message: 'bad input',
      code: 'E_BAD',
    });
    expect(e.error.stack).toContain('TypeError: bad input');
    expect(w.error.stack).toBeUndefined();
  });
});

describe('StructuredLogger — robustness and log injection', () => {
  it('keeps a CRLF-laden message on ONE line and cannot forge a second record', () => {
    const { logger, lines, records } = capture();
    logger.log('user said hi\r\n{"level":"fatal","event":"forged"}\u2028next');
    expect(lines).toHaveLength(1);
    expect(records()).toHaveLength(1);
    const r = records()[0];
    expect(r.level).toBe('info');
    expect(r.message).not.toMatch(/[\r\n\u2028]/);
    expect(lines[0]).not.toMatch(/\r|\n(?!$)/);
  });

  it('does not throw on circular, BigInt, Date, class-instance and huge values', () => {
    const { logger, records } = capture();
    const circular: any = { a: 1 };
    circular.self = circular;
    class Entity {
      secretColumn = 'should never be serialized';
    }
    expect(() =>
      logger.log({
        event: 'app.test.robust',
        message: 'x'.repeat(20_000),
        circular,
        big: BigInt(10),
        when: new Date('2026-01-01T00:00:00Z'),
        entity: new Entity(),
      }),
    ).not.toThrow();
    const r = records()[0];
    expect(r.message.length).toBeLessThan(9_000);
    expect(r.big).toBe('10');
    expect(r.when).toBe('2026-01-01T00:00:00.000Z');
    expect(r.entity).toBe('[Entity]');
    expect(JSON.stringify(r)).not.toContain('should never be serialized');
  });
});

describe('StructuredLogger — context propagation', () => {
  const ctx = new TenantContextService();

  it('adds request_id, user_id and tenant_id from the tenant context, across awaits', async () => {
    const { logger, records } = capture();
    await ctx.run(async () => {
      ctx.setCorrelationId('req-123');
      ctx.setPrincipal({
        id: 'user-1',
        tenantId: 'tenant-1',
        roles: [],
        permissions: [],
      });
      logger.log('before await');
      await new Promise((r) => setTimeout(r, 5));
      await Promise.resolve();
      logger.log('after await');
    });
    for (const r of records()) {
      expect(r).toMatchObject({
        request_id: 'req-123',
        user_id: 'user-1',
        tenant_id: 'tenant-1',
      });
    }
  });

  it('keeps two concurrent requests isolated', async () => {
    const { logger, records } = capture();
    const one = (id: string, tenant: string, delay: number) =>
      ctx.run(async () => {
        ctx.setCorrelationId(id);
        ctx.setPrincipal({
          id: `u-${id}`,
          tenantId: tenant,
          roles: [],
          permissions: [],
        });
        await new Promise((r) => setTimeout(r, delay));
        logger.log(`done ${id}`);
      });
    await Promise.all([one('a', 't-a', 15), one('b', 't-b', 1)]);
    const byMsg = Object.fromEntries(records().map((r) => [r.message, r]));
    expect(byMsg['done a']).toMatchObject({
      request_id: 'a',
      tenant_id: 't-a',
    });
    expect(byMsg['done b']).toMatchObject({
      request_id: 'b',
      tenant_id: 't-b',
    });
  });

  it('marks platform super-admin operations', () => {
    const { logger, records } = capture();
    ctx.run(() => {
      ctx.setPrincipal({
        id: 'admin-1',
        tenantId: null,
        roles: ['super_admin'],
        permissions: [],
      });
      logger.log('platform op');
    });
    const r = records()[0];
    expect(r.platform_admin).toBe(true);
    expect(r.tenant_id).toBeUndefined();
  });

  it('adds no identity outside a request or job', () => {
    const { logger, records } = capture();
    logger.log('boot');
    const r = records()[0];
    expect(r.request_id).toBeUndefined();
    expect(r.tenant_id).toBeUndefined();
    expect(r.user_id).toBeUndefined();
  });

  it('adds job fields inside a job, surviving a nested tenant context', async () => {
    const { logger, records } = capture();
    await runWithJobLogContext(
      {
        queue: 'email',
        job_name: 'email.send',
        job_id: '123456789012',
        attempt: 2,
        max_attempts: 5,
      },
      () =>
        ctx.run(async () => {
          ctx.setCorrelationId('origin-req');
          await Promise.resolve();
          logger.log('inside job');
        }),
    );
    expect(records()[0]).toMatchObject({
      queue: 'email',
      job_name: 'email.send',
      job_id: '123456789012',
      attempt: 2,
      request_id: 'origin-req',
    });
  });
});
