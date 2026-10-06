import { ConsoleLogger } from '@nestjs/common';

import { sanitizeForLog } from '../utils/sanitize.util';
import { scrubText } from '../utils/log-scrubber.util';

/**
 * The single redaction seam for every `Logger` call in the process (residency
 * plan P7).
 *
 * Call sites across the API and the worker log `err.message`, `failedReason`
 * and interpolated ids directly — there are far too many to audit one by one,
 * and the next one written would be unaudited too. Installing this as the
 * application logger means every line, whoever wrote it, passes through the
 * same scrubber before it reaches stdout (and so before it reaches CloudWatch).
 *
 * Output format is exactly Nest's `ConsoleLogger`; only the content changes:
 *  - strings are scrubbed by value shape (emails, phone / ID / card-length
 *    digit runs, JWTs, bearer tokens, signed-URL parameters, driver row values);
 *  - objects are passed through the key-based `sanitizeForLog`, which also
 *    scrubs every string inside;
 *  - an `Error` keeps its name and stack but with both scrubbed.
 *
 * It does not change log LEVELS or what is logged — only what is written.
 */
export class RedactingLogger extends ConsoleLogger {
  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(scrubArg(message), ...optionalParams.map(scrubArg));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(scrubArg(message), ...optionalParams.map(scrubArg));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(scrubArg(message), ...optionalParams.map(scrubArg));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(scrubArg(message), ...optionalParams.map(scrubArg));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(scrubArg(message), ...optionalParams.map(scrubArg));
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(scrubArg(message), ...optionalParams.map(scrubArg));
  }
}

/** Plain objects and arrays only — a Date, Map or Buffer would be flattened to `{}` by a key walk. */
function isPlainData(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Scrubs one logger argument. Never throws: on any failure the argument is dropped to a marker. */
export function scrubArg(arg: unknown): unknown {
  try {
    if (typeof arg === 'string') return scrubText(arg);
    if (arg instanceof Error) {
      const copy = new Error(scrubText(arg.message));
      copy.name = arg.name;
      copy.stack = arg.stack ? scrubText(arg.stack) : undefined;
      return copy;
    }
    if (isPlainData(arg)) return sanitizeForLog(arg);
    return arg;
  } catch {
    return '[unloggable value]';
  }
}
