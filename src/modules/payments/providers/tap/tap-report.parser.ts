/**
 * Parser for Tap's `POST /v2/charges/download` CSV (and the same file an operator
 * can export from Tap's dashboard when the API is not reachable for a merchant).
 *
 * The report is the ONLY place Tap states a charge's fee (`fee`, `fee_vat`,
 * `net_amount`) and which payout paid it out (`payout_id`, `settlement_date`), so
 * this parser feeds both the daily reconciliation and the manual CSV import.
 *
 * It is a trust boundary — an operator can paste anything — so it is strict where
 * strictness is cheap and honest where it is not:
 *  - a file without the columns we need is REJECTED, never half-read;
 *  - a ROW that does not parse (bad id, currency or amount, wrong column count) is
 *    skipped and COUNTED, never guessed at;
 *  - numbers and dates are only accepted in forms that cannot be misread.
 *
 * Column names are exactly those Tap documents:
 * https://developers.tap.company/reference/download-charges (verified 2026-10-05).
 * The amount unit (major units, as everywhere else in Tap's API) and the date
 * format of the `*_date` columns are NOT documented for the CSV, hence the
 * tolerant date parser and the sandbox-validation note in the Phase 5 doc.
 */

export class TapReportParseError extends Error {}

export interface TapChargeReportRow {
  chargeId: string;
  /** Upper-cased Tap status (`CAPTURED`, `DECLINED`, …). */
  status: string;
  /** Upper-cased ISO currency. */
  currency: string;
  /** Major units. */
  amount: number;
  fee?: number;
  feeVat?: number;
  netAmount?: number;
  payoutId?: string;
  settlementId?: string;
  merchantId?: string;
  /** Our payment / invoice id (`reference.transaction` we sent). */
  referenceTransaction?: string;
  /** Our appointment id (`reference.order` we sent). */
  referenceOrder?: string;
  paymentMethod?: string;
  chargeDate?: Date;
  settlementDate?: Date;
  payoutDate?: Date;
}

export interface TapChargeReport {
  rows: TapChargeReportRow[];
  /** Data rows that were present but unusable (counted so the caller can surface them). */
  skipped: number;
}

const REQUIRED_COLUMNS = ['charge_id', 'amount', 'currency', 'status'] as const;
const ID = /^[A-Za-z0-9_-]{3,96}$/;
const CURRENCY = /^[A-Za-z]{3}$/;

/** RFC 4180: quoted fields, `""` escapes, CRLF or LF, an optional BOM, no trailing blank row. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // a completely empty line (a single empty field) is not a row
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    sawAny = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
    } else if (ch === '\n') {
      endRow();
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new TapReportParseError('Unterminated quoted field');
  if (sawAny && (field !== '' || row.length > 0)) endRow();
  return rows;
}

/** A plain decimal, optionally with thousands commas. Anything else is `undefined`, never a guess. */
export function parseMoney(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  const plain = /^-?\d+(\.\d+)?$/.test(t)
    ? t
    : /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)
      ? t.replace(/,/g, '')
      : null;
  if (plain === null) return undefined;
  const n = Number(plain);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Tap's CSV prints `DD/MM/YYYY hh:mm AM|PM` in UTC (sandbox, 2026-10-04: a charge made
 * at 15:14 UTC on 4 October reads `04/10/2026 03:14 PM`). `Date.parse` would read that
 * as 10 April in the SERVER's timezone, so a slash date is parsed here and nowhere else.
 */
const SLASH_DATE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;

function parseSlashDate(t: string): Date | undefined {
  const m = SLASH_DATE.exec(t);
  if (!m) return undefined;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const meridiem = m[7]?.toUpperCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // `Date.UTC` rolls 31/02 into March — a date that does not exist is not a date.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : undefined;
}

/**
 * Epoch seconds / milliseconds, Tap's `DD/MM/YYYY hh:mm AM|PM` (UTC), or an ISO string
 * that `Date.parse` reads unambiguously. Any other slash form is refused, never guessed.
 */
export function parseReportDate(v: string | undefined): Date | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  if (/^\d{13}$/.test(t)) return new Date(Number(t));
  if (/^\d{10}$/.test(t)) return new Date(Number(t) * 1000);
  if (/^\d+$/.test(t)) return undefined; // some other bare number: not a date we can trust
  if (t.includes('/')) return parseSlashDate(t);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

const clean = (v: string | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t === '' ? undefined : t;
};

/** Parse a charges-download CSV into typed rows. Throws only when the FILE is unusable. */
export function parseChargeReport(csv: string): TapChargeReport {
  const table = parseCsv(csv ?? '');
  if (table.length === 0) return { rows: [], skipped: 0 };

  const header = table[0].map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new TapReportParseError(
      `Not a Tap charges report: missing column(s) ${missing.join(', ')}`,
    );
  }
  const at = (name: string) => header.indexOf(name);
  const col = {
    chargeId: at('charge_id'),
    status: at('status'),
    currency: at('currency'),
    amount: at('amount'),
    fee: at('fee'),
    feeVat: at('fee_vat'),
    net: at('net_amount'),
    payoutId: at('payout_id'),
    settlementId: at('settlement_id'),
    merchantId: at('merchant_id'),
    refTransaction: at('reference_transaction'),
    refOrder: at('reference_order'),
    method: at('payment_method'),
    chargeDate: at('charge_date'),
    settlementDate: at('settlement_date'),
    payoutDate: at('payout_date'),
  };

  const rows: TapChargeReportRow[] = [];
  let skipped = 0;
  for (const cells of table.slice(1)) {
    const cell = (i: number) => (i >= 0 ? cells[i] : undefined);
    const chargeId = clean(cell(col.chargeId));
    const currency = clean(cell(col.currency));
    const amount = parseMoney(cell(col.amount));
    const status = clean(cell(col.status));

    if (
      cells.length !== header.length ||
      !chargeId ||
      !ID.test(chargeId) ||
      !currency ||
      !CURRENCY.test(currency) ||
      amount === undefined ||
      !status
    ) {
      skipped += 1;
      continue;
    }

    rows.push({
      chargeId,
      status: status.toUpperCase(),
      currency: currency.toUpperCase(),
      amount,
      fee: parseMoney(cell(col.fee)),
      feeVat: parseMoney(cell(col.feeVat)),
      netAmount: parseMoney(cell(col.net)),
      payoutId: clean(cell(col.payoutId)),
      settlementId: clean(cell(col.settlementId)),
      merchantId: clean(cell(col.merchantId)),
      referenceTransaction: clean(cell(col.refTransaction)),
      referenceOrder: clean(cell(col.refOrder)),
      paymentMethod: clean(cell(col.method))?.toLowerCase(),
      chargeDate: parseReportDate(cell(col.chargeDate)),
      settlementDate: parseReportDate(cell(col.settlementDate)),
      payoutDate: parseReportDate(cell(col.payoutDate)),
    });
  }
  return { rows, skipped };
}
