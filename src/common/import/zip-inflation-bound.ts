import { inflateRawSync } from 'node:zlib';

/**
 * RL-06 — bounds how much an uploaded `.xlsx` (a zip) may inflate to BEFORE a
 * parser builds it in memory. `exceljs` inflates every part and builds the
 * whole workbook before any row ceiling can run, so the compressed-size cap
 * alone let a few MB of upload expand far past the API task's memory.
 *
 * Two independent checks, both before any third-party parser sees the bytes:
 *  1. the DECLARED sizes in the zip central directory (cheap; refuses honest
 *     oversized files and every ZIP64 archive, which no import needs);
 *  2. the REAL inflated size of every entry, decompressed with zlib's
 *     `maxOutputLength` against the remaining budget — a crafted archive that
 *     under-declares its sizes is cut off at the budget, never allocated past it.
 *
 * Pure function over the buffer: no I/O, nothing retained after it returns.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

export interface ZipInflationLimits {
  /** Total bytes all entries may inflate to. */
  maxUncompressedBytes: number;
  /** Entries the archive may contain. */
  maxEntries: number;
}

/** Why an archive was refused — mapped to a user-facing error by the caller. */
export class ZipInflationError extends Error {
  constructor(
    readonly reason:
      | 'not_a_zip'
      | 'too_many_entries'
      | 'too_large'
      | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'ZipInflationError';
  }
}

interface CentralEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function assertZipInflationBounded(
  buffer: Buffer,
  limits: ZipInflationLimits,
): void {
  const entries = readCentralDirectory(buffer, limits.maxEntries);

  let declared = 0;
  for (const e of entries) declared += e.uncompressedSize;
  if (declared > limits.maxUncompressedBytes) {
    throw new ZipInflationError(
      'too_large',
      'Archive declares more uncompressed data than allowed',
    );
  }

  let remaining = limits.maxUncompressedBytes;
  for (const e of entries) {
    const data = entryData(buffer, e);
    let produced: number;
    if (e.method === METHOD_STORED) {
      produced = data.length;
    } else if (e.method === METHOD_DEFLATE) {
      try {
        // +1 so "exactly at the budget" passes and one byte more throws.
        produced = inflateRawSync(data, {
          maxOutputLength: remaining + 1,
        }).length;
      } catch (err) {
        if (
          (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ||
          err instanceof RangeError
        ) {
          throw new ZipInflationError(
            'too_large',
            'Archive inflates to more data than allowed',
          );
        }
        throw new ZipInflationError(
          'not_a_zip',
          'Archive entry could not be decompressed',
        );
      }
    } else {
      throw new ZipInflationError(
        'unsupported',
        `Unsupported zip compression method ${e.method}`,
      );
    }
    remaining -= produced;
    if (remaining < 0) {
      throw new ZipInflationError(
        'too_large',
        'Archive inflates to more data than allowed',
      );
    }
  }
}

function readCentralDirectory(
  buffer: Buffer,
  maxEntries: number,
): CentralEntry[] {
  const eocd = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // 0xFFFF / 0xFFFFFFFF mean "see the ZIP64 record" — no import file needs ZIP64.
  if (
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ZipInflationError(
      'unsupported',
      'ZIP64 archives are not accepted',
    );
  }
  if (totalEntries > maxEntries) {
    throw new ZipInflationError(
      'too_many_entries',
      'Archive has too many entries',
    );
  }
  if (cdOffset + cdSize > eocd) {
    throw new ZipInflationError('not_a_zip', 'Central directory out of bounds');
  }

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (
      p + 46 > buffer.length ||
      buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE
    ) {
      throw new ZipInflationError('not_a_zip', 'Malformed central directory');
    }
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ZipInflationError(
        'unsupported',
        'ZIP64 archives are not accepted',
      );
    }
    entries.push({
      method: buffer.readUInt16LE(p + 10),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    p +=
      46 +
      buffer.readUInt16LE(p + 28) +
      buffer.readUInt16LE(p + 30) +
      buffer.readUInt16LE(p + 32);
  }
  return entries;
}

function findEocd(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_LENGTH) {
    throw new ZipInflationError('not_a_zip', 'Too short to be a zip archive');
  }
  const stop = Math.max(
    0,
    buffer.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH,
  );
  for (let i = buffer.length - EOCD_MIN_LENGTH; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipInflationError(
    'not_a_zip',
    'End of central directory not found',
  );
}

function entryData(buffer: Buffer, e: CentralEntry): Buffer {
  const p = e.localHeaderOffset;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== LOCAL_SIGNATURE) {
    throw new ZipInflationError('not_a_zip', 'Malformed local header');
  }
  const start =
    p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buffer.length) {
    throw new ZipInflationError('not_a_zip', 'Entry data out of bounds');
  }
  return buffer.subarray(start, end);
}
