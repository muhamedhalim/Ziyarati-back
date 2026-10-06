import { Logger } from '@nestjs/common';

import { RedactingLogger, scrubArg } from './redacting-logger';

/** Captures what the logger finally writes by intercepting stdout/stderr. */
function capture(run: (logger: RedactingLogger) => void): string {
  const chunks: string[] = [];
  const out = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((c: unknown) => (chunks.push(String(c)), true));
  const err = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((c: unknown) => (chunks.push(String(c)), true));
  try {
    run(new RedactingLogger());
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
  return chunks.join('');
}

describe('RedactingLogger', () => {
  it('scrubs identifiers out of a plain log line at every level', () => {
    const written = capture((l) => {
      l.log('sent to sara@example.com', 'Ctx');
      l.warn('retry for 0501234567', 'Ctx');
      l.error('failed for 29801011234567', undefined, 'Ctx');
      l.debug('debug 0501234567', 'Ctx');
      l.verbose('verbose sara@example.com', 'Ctx');
      l.fatal('fatal 0501234567', 'Ctx');
    });
    expect(written).not.toMatch(/sara@example\.com|0501234567|29801011234567/);
    expect(written).toContain('[EMAIL]');
    expect(written).toContain('[NUMBER]');
  });

  it('keeps the context and the surrounding text', () => {
    const written = capture((l) =>
      l.log('queue drained in 120ms', 'QueueMonitor'),
    );
    expect(written).toContain('QueueMonitor');
    expect(written).toContain('queue drained in 120ms');
  });

  it('scrubs the message and the stack of an error', () => {
    const err = new Error('bad recipient 0501234567');
    err.stack = 'Error: bad recipient 0501234567\n    at mailer.ts:1:1';
    const written = capture((l) => l.error(err));
    expect(written).not.toContain('0501234567');
    expect(written).toContain('mailer.ts:1:1');
  });

  it('applies key-based redaction to logged objects', () => {
    const written = capture((l) =>
      l.log(
        { password: 'hunter2', note: 'private text', jobId: 'job-1' },
        'Ctx',
      ),
    );
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('private text');
    expect(written).toContain('job-1');
  });

  it('is the format Nest already uses (a static Logger routed through it still works)', () => {
    Logger.overrideLogger(new RedactingLogger());
    try {
      const written = capture(() =>
        new Logger('Static').log('from 0501234567'),
      );
      expect(written).toContain('Static');
      expect(written).not.toContain('0501234567');
    } finally {
      Logger.overrideLogger(['log', 'error', 'warn']);
    }
  });
});

describe('scrubArg', () => {
  it('leaves non-plain objects and primitives untouched', () => {
    const date = new Date(0);
    const map = new Map([['a', 1]]);
    expect(scrubArg(date)).toBe(date);
    expect(scrubArg(map)).toBe(map);
    expect(scrubArg(42)).toBe(42);
    expect(scrubArg(undefined)).toBeUndefined();
    expect(scrubArg(null)).toBeNull();
  });

  it('never throws, even on a hostile object', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => scrubArg(hostile)).not.toThrow();
  });
});
