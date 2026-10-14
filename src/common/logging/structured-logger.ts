import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

import { sanitizeForLog } from '../utils/sanitize.util';
import { scrubText } from '../utils/log-scrubber.util';
import { currentLogContext } from './log-context';
import { contextToEventPrefix } from './log-events';
import {
  resolveLogConfig,
  type LogConfig,
  type ProcessRole,
} from './log-config';

/**
 * The application logger for every process root (API, worker): one JSON
 * object per line on stdout (stderr for error/fatal), in the schema documented
 * in LOGGING.md.
 *
 * It is a Nest `LoggerService`, so the ~250 existing `new Logger(ctx)` call
 * sites keep working unchanged — a plain string becomes `message`, Nest's
 * context becomes `context`, and the line is filed under `<context>.log`.
 * Code that wants a searchable event passes an object instead:
 *
 *     this.logger.warn({ event: LOG_EVENT.X, message: 'what happened', foo_id });
 *
 * Redaction is the SAME seam `RedactingLogger` used (residency plan P7):
 *  - free text (message, error message, stack) is scrubbed by value shape;
 *  - structured fields go through the key-based `sanitizeForLog`, which also
 *    scrubs every string inside them;
 *  - context fields (request/user/tenant/job/trace ids) come only from
 *    `currentLogContext()`, i.e. from authenticated or authorized state.
 *
 * Writes are synchronous (same as Nest's ConsoleLogger on a Linux pipe), so a
 * crash never loses the line that explains it; the ECS `awslogs` driver runs in
 * non-blocking mode, so stdout back-pressure cannot stall the event loop.
 * Nothing here ever throws into the caller.
 */

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface SerializedError {
  type: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: { type: string; message: string };
}

export interface LogMetricsSink {
  onLog(level: Level): void;
  onWriteFailure(): void;
}

export interface StructuredLoggerOptions {
  role: ProcessRole;
  env?: NodeJS.ProcessEnv;
  /** Test seam: receives every serialized line instead of stdout/stderr. */
  destination?: DestinationStream;
  /** Test seam: overrides the resolved configuration. */
  config?: Partial<LogConfig>;
}

const MAX_MESSAGE_LENGTH = 8_192;
const EVENT_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+){1,5}$/;
/** Base fields a caller's structured fields may never overwrite. */
const RESERVED_KEYS = new Set([
  'timestamp',
  'level',
  'service',
  'env',
  'version',
  'pid',
]);
/**
 * Server-generated identifiers that may legitimately be long digit runs (BullMQ
 * job ids) and would otherwise be eaten by the digit-run scrubber. Only exempt
 * when the value is itself identifier-shaped.
 */
const ID_KEYS = new Set(['request_id', 'job_id', 'trace_id', 'span_id']);
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** Same check Nest's ConsoleLogger uses to tell `error(msg, stack)` from `error(msg, ctx)`. */
const STACK_RE = /^(.)+\n\s+at .+:\d+:\d+/;
// Every C0 control character except TAB (so CR/LF too), DEL, and the U+2028/2029 line separators.
const CONTROL_RE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\u0000-\u0008\u000A-\u001F\u007F\u2028\u2029]',
  'g',
);

let logMetricsSink: LogMetricsSink | undefined;
let rootLogger: StructuredLogger | undefined;

/** Registered by `MetricsService` so log volume per level is a Prometheus counter. */
export function setLogMetricsSink(sink: LogMetricsSink | undefined): void {
  logMetricsSink = sink;
}

/** The process's application logger, for code that runs outside Nest DI (process handlers). */
export function getRootLogger(): StructuredLogger | undefined {
  return rootLogger;
}

/** Idempotent: the preload (logger-api.ts / logger-worker.ts) and bootstrap share one instance. */
export function createRootLogger(role: ProcessRole): StructuredLogger {
  rootLogger ??= new StructuredLogger({ role });
  return rootLogger;
}

export class StructuredLogger implements LoggerService {
  readonly config: LogConfig;
  private readonly pino: PinoLogger;

  constructor(options: StructuredLoggerOptions) {
    this.config = {
      ...resolveLogConfig(options.role, options.env),
      ...options.config,
    };
    const destination =
      options.destination ??
      (this.config.format === 'pretty'
        ? prettyDestination()
        : stdioDestination());
    this.pino = pino(
      {
        level: this.config.level,
        messageKey: 'message',
        base: {
          service: this.config.service,
          env: this.config.env,
          version: this.config.version,
          pid: process.pid,
        },
        timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
        formatters: { level: (label) => ({ level: label }) },
      },
      destination,
    );
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams, false);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams, true);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams, false);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams, false);
  }

  /** Nest's `verbose` has no counterpart in the schema's five levels — it is diagnostic detail. */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams, false);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams, false);
  }

  /** Levels are governed by `LOG_LEVEL`, not by Nest's per-app `logger` array. */
  setLogLevels(): void {
    // intentionally a no-op
  }

  isLevelEnabled(level: Level): boolean {
    return this.pino.isLevelEnabled(level);
  }

  /** Structured API for code holding the instance directly (bootstrap, process handlers). */
  event(
    level: Level,
    event: string,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.write(level, { ...fields, event, message }, [], false);
  }

  private write(
    level: Level,
    message: unknown,
    params: unknown[],
    isErrorMethod: boolean,
  ): void {
    if (!this.pino.isLevelEnabled(level)) return;
    try {
      const record = this.buildRecord(level, message, params, isErrorMethod);
      this.pino[level](record);
      logMetricsSink?.onLog(level);
    } catch {
      logMetricsSink?.onWriteFailure();
      try {
        process.stderr.write(
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            level,
            service: this.config.service,
            env: this.config.env,
            version: this.config.version,
            event: 'logger.write_failed',
            message: 'A log line could not be serialized and was dropped.',
          })}\n`,
        );
      } catch {
        // nothing left to do
      }
    }
  }

  private buildRecord(
    level: Level,
    message: unknown,
    params: unknown[],
    isErrorMethod: boolean,
  ): Record<string, unknown> {
    const { context, stack, extras } = parseNestArgs(params, isErrorMethod);
    const withStack = level === 'error' || level === 'fatal';

    let text: string;
    let event: string | undefined;
    let error: SerializedError | undefined;
    let fields: Record<string, unknown> = {};

    if (message instanceof Error) {
      text = message.message;
      error = serializeError(message, withStack);
    } else if (isPlainObject(message)) {
      const {
        message: m,
        msg,
        event: e,
        error: err,
        ...rest
      } = message as Record<string, unknown>;
      event = typeof e === 'string' && EVENT_RE.test(e) ? e : undefined;
      text =
        typeof m === 'string'
          ? m
          : typeof msg === 'string'
            ? msg
            : (event ?? 'structured log');
      if (err !== undefined && err !== null)
        error = serializeError(err, withStack);
      fields = sanitizeFields(rest);
    } else if (typeof message === 'string') {
      text = message;
    } else {
      text = safeString(message);
    }

    if (stack) {
      if (!error)
        error = {
          type: 'Error',
          message: cleanText(text),
          stack: scrubText(stack),
        };
      else if (!error.stack) error.stack = scrubText(stack);
    }
    if (extras.length) fields.extra = extras.map((x) => sanitizeValue(x));

    const record: Record<string, unknown> = {
      ...currentLogContext(),
      ...fields,
      event: event ?? `${contextToEventPrefix(context)}.log`,
      message: cleanText(text),
    };
    if (context) record.context = cleanText(context).slice(0, 128);
    if (error) record.error = error;
    return record;
  }
}

/**
 * Mirrors Nest's ConsoleLogger: a trailing string argument is the context
 * (Nest's `Logger` appends it); for `error`, a stack-shaped string is the stack.
 */
function parseNestArgs(
  params: unknown[],
  isErrorMethod: boolean,
): { context?: string; stack?: string; extras: unknown[] } {
  const args = [...params];
  let context: string | undefined;
  let stack: string | undefined;

  if (isErrorMethod && args.length === 1 && isStackString(args[0])) {
    return { stack: args[0] as string, extras: [] };
  }
  if (args.length > 0 && typeof args[args.length - 1] === 'string') {
    context = args.pop() as string;
  }
  if (isErrorMethod && args.length > 0) {
    const last = args[args.length - 1];
    if (typeof last === 'string' || last === undefined) {
      args.pop();
      if (typeof last === 'string' && last.length > 0) stack = last;
    }
  }
  return { context, stack, extras: args.filter((a) => a !== undefined) };
}

function isStackString(value: unknown): boolean {
  return typeof value === 'string' && STACK_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Scrubbed, single-line, length-capped text. */
export function cleanText(input: string): string {
  const scrubbed = scrubText(input).replace(CONTROL_RE, ' ');
  return scrubbed.length > MAX_MESSAGE_LENGTH
    ? `${scrubbed.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]`
    : scrubbed;
}

function sanitizeFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const safeKey = RESERVED_KEYS.has(key) ? `data_${key}` : key;
    if (
      ID_KEYS.has(key) &&
      typeof value === 'string' &&
      SAFE_ID_RE.test(value)
    ) {
      out[safeKey] = value;
      continue;
    }
    // Wrap so the key itself is checked by the key-based redactor too.
    out[safeKey] = (
      sanitizeForLog({ [key]: sanitizeValue(value) }) as Record<string, unknown>
    )[key];
  }
  return out;
}

/** Errors inside fields become serialized errors; everything else is left for `sanitizeForLog`. */
function sanitizeValue(value: unknown): unknown {
  if (value instanceof Error) return serializeError(value, false);
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !isPlainObject(value)
  ) {
    // Never serialize class instances (ORM entities, requests, sockets) — name only.
    return `[${(value as object).constructor?.name ?? 'Object'}]`;
  }
  return sanitizeForLog(value);
}

export function serializeError(
  err: unknown,
  withStack: boolean,
): SerializedError {
  if (isPlainObject(err) && typeof err.message === 'string') {
    // Already shaped by the caller (e.g. AllExceptionsFilter): re-clean every field anyway.
    const out: SerializedError = {
      type: typeof err.type === 'string' ? err.type.slice(0, 64) : 'Error',
      message: cleanText(err.message),
    };
    if (typeof err.code === 'string' || typeof err.code === 'number') {
      out.code = cleanText(String(err.code)).slice(0, 64);
    }
    if (withStack && typeof err.stack === 'string')
      out.stack = scrubText(err.stack);
    const cause = err.cause;
    if (isPlainObject(cause) && typeof cause.message === 'string') {
      out.cause = {
        type:
          typeof cause.type === 'string' ? cause.type.slice(0, 64) : 'Error',
        message: cleanText(cause.message),
      };
    }
    return out;
  }
  if (err instanceof Error) {
    const out: SerializedError = {
      type: (err.name || 'Error').slice(0, 64),
      message: cleanText(err.message ?? ''),
    };
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number')
      out.code = cleanText(String(code)).slice(0, 64);
    if (withStack && err.stack) out.stack = scrubText(err.stack);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      out.cause = {
        type: (cause.name || 'Error').slice(0, 64),
        message: cleanText(cause.message ?? ''),
      };
    }
    return out;
  }
  return { type: 'NonError', message: cleanText(safeString(err)) };
}

function safeString(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    if (typeof value === 'function') return '[function]';
    const json = JSON.stringify(sanitizeForLog(value));
    return json ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/** error/fatal → stderr, everything else → stdout; synchronous writes. */
function stdioDestination(): DestinationStream {
  return pino.multistream(
    [
      { level: 'debug', stream: pino.destination({ dest: 1, sync: true }) },
      { level: 'error', stream: pino.destination({ dest: 2, sync: true }) },
    ],
    { dedupe: true },
  );
}

const PRETTY_FIELDS_SKIP = new Set([
  'timestamp',
  'level',
  'service',
  'env',
  'version',
  'pid',
  'message',
  'context',
  'error',
]);

/**
 * Local-development rendering: one readable line per record, the structured
 * fields kept as `key=value` so nothing seen in production is hidden locally.
 */
function prettyDestination(): DestinationStream {
  return {
    write(line: string): void {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        process.stdout.write(line);
        return;
      }
      const level = String(rec.level ?? 'info')
        .toUpperCase()
        .padEnd(5);
      const time = String(rec.timestamp ?? '').slice(11, 23);
      const ctx = rec.context ? `[${String(rec.context)}] ` : '';
      const extras = Object.entries(rec)
        .filter(([k]) => !PRETTY_FIELDS_SKIP.has(k))
        .map(
          ([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`,
        )
        .join(' ');
      const err = rec.error as SerializedError | undefined;
      const errText = err
        ? `\n  ${err.type}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
        : '';
      const out = `${time} ${level} ${ctx}${String(rec.message ?? '')}${extras ? `  ${extras}` : ''}${errText}\n`;
      const stream =
        rec.level === 'error' || rec.level === 'fatal'
          ? process.stderr
          : process.stdout;
      stream.write(out);
    },
  };
}
