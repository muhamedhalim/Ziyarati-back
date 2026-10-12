import { AppError, ErrorCode } from '../../../common/errors';

/**
 * Strict ISO-8601 date-time with an EXPLICIT offset — the contract the
 * Integration API publishes for every timestamp (`Z` or `±hh:mm`).
 *
 * Why not `new Date(value)`: it accepts offset-less strings (interpreted in the
 * API process' local time zone — a silent, deployment-dependent shift), numeric
 * epochs and many non-ISO spellings. An appointment instant must never depend on
 * the server's time zone, so anything without an offset is refused.
 */
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

export function parseOffsetTimestamp(value: unknown, field: string): Date {
  const fail = (why: string): never => {
    throw new AppError(ErrorCode.VALIDATION_ERROR, {
      message: `${field} must be an ISO-8601 date-time with an explicit UTC offset (e.g. 2026-10-28T10:00:00+03:00 or ...Z)`,
      publicContext: { fields: [field], reason: why },
    });
  };

  if (typeof value !== 'string') return fail('not_a_string');
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return fail('format_or_offset');

  const [, y, mo, d, h, mi, s = '0', , , offH, offM] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12) return fail('calendar');
  // Calendar validity (rejects 2026-02-30, which Date would roll over silently).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return fail('calendar');
  }
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return fail('clock');
  if (offH !== undefined && (Number(offH) > 23 || Number(offM) > 59)) return fail('offset');

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fail('unparseable');
  return parsed;
}
