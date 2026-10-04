import {
  parseChargeReport,
  parseCsv,
  parseMoney,
  parseReportDate,
  TapReportParseError,
} from './tap-report.parser';

const HEADER =
  'payout_id,settlement_id,charge_id,currency,amount,status,charge_date,settlement_date,payout_date,reference_transaction,reference_order,payment_method,merchant_id,fee,fee_vat,net_amount';

const line = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    payout_id: 'payout_1',
    settlement_id: 'stl_1',
    charge_id: 'chg_1',
    currency: 'SAR',
    amount: '250.00',
    status: 'CAPTURED',
    charge_date: '1744036133441',
    settlement_date: '1744122533441',
    payout_date: '1744208933441',
    reference_transaction: 'pay-1',
    reference_order: 'appt-1',
    payment_method: 'MADA',
    merchant_id: 'merchant_1',
    fee: '3.75',
    fee_vat: '0.56',
    net_amount: '245.69',
    ...over,
  };
  return HEADER.split(',')
    .map((h) => base[h])
    .join(',');
};

describe('parseCsv (RFC 4180)', () => {
  it('splits rows and fields, tolerating CRLF, LF and a trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\n3,4\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });
  it('strips a BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
  it('handles quoted fields with commas, newlines and escaped quotes', () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi""\nthere"\n')).toEqual([
      ['a', 'b'],
      ['x,y', 'he said "hi"\nthere'],
    ]);
  });
  it('keeps empty cells and ignores blank lines', () => {
    expect(parseCsv('a,b,c\n1,,3\n\n4,5,\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['4', '5', ''],
    ]);
  });
  it('an unterminated quote is an error, not a silently swallowed file', () => {
    expect(() => parseCsv('a,b\n"oops,1\n')).toThrow(TapReportParseError);
  });
  it('empty input has no rows', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseMoney', () => {
  it.each([
    ['250.00', 250],
    ['0.5', 0.5],
    ['-1.25', -1.25],
    ['1,234.56', 1234.56],
    [' 12 ', 12],
  ])('%s → %s', (v, n) => expect(parseMoney(v)).toBe(n));
  it.each(['', '  ', 'abc', '1.2.3', '1,23', '1e3', 'NaN', '٣٫٥', '--1'])(
    '%j is never guessed at',
    (v) => expect(parseMoney(v)).toBeUndefined(),
  );
  it('undefined stays undefined', () =>
    expect(parseMoney(undefined)).toBeUndefined());
});

describe('parseReportDate', () => {
  it('reads epoch milliseconds and seconds', () => {
    expect(parseReportDate('1744036133441')?.getTime()).toBe(1744036133441);
    expect(parseReportDate('1744036133')?.getTime()).toBe(1744036133000);
  });
  it('reads an ISO date', () => {
    expect(parseReportDate('2026-10-04T10:00:00Z')?.toISOString()).toBe(
      '2026-10-04T10:00:00.000Z',
    );
  });
  it("reads Tap's real CSV format DD/MM/YYYY hh:mm AM|PM as UTC (never as MM/DD, never in the server's timezone)", () => {
    // Captured from the real sandbox on 2026-10-04: a charge made at 15:14 UTC.
    expect(parseReportDate('04/10/2026 03:14 PM')?.toISOString()).toBe(
      '2026-10-04T15:14:00.000Z',
    );
    expect(parseReportDate('25/12/2026 12:05 AM')?.toISOString()).toBe(
      '2026-12-25T00:05:00.000Z',
    );
    expect(parseReportDate('25/12/2026 12:05 PM')?.toISOString()).toBe(
      '2026-12-25T12:05:00.000Z',
    );
    expect(parseReportDate('04/10/2026')?.toISOString()).toBe(
      '2026-10-04T00:00:00.000Z',
    );
  });
  it.each([
    '13/13/2026 01:00 PM', // no month 13
    '31/02/2026 01:00 PM', // no 31 February
    '04/10/2026 13:14 PM', // 13 o'clock with a meridiem
    '04/10/2026 00:14 AM',
    '2026/10/04 03:14 PM', // year-first slash form is not Tap's
  ])('%j (impossible / unknown slash form) → undefined', (v) =>
    expect(parseReportDate(v)).toBeUndefined(),
  );
  it.each(['', 'soon', '12345', undefined])('%j → undefined', (v) =>
    expect(parseReportDate(v as string | undefined)).toBeUndefined(),
  );
});

describe('parseChargeReport', () => {
  it('maps a full row, upper-casing status / currency and lower-casing the method', () => {
    const { rows, skipped } = parseChargeReport(`${HEADER}\n${line()}\n`);
    expect(skipped).toBe(0);
    expect(rows).toEqual([
      {
        chargeId: 'chg_1',
        status: 'CAPTURED',
        currency: 'SAR',
        amount: 250,
        fee: 3.75,
        feeVat: 0.56,
        netAmount: 245.69,
        payoutId: 'payout_1',
        settlementId: 'stl_1',
        merchantId: 'merchant_1',
        referenceTransaction: 'pay-1',
        referenceOrder: 'appt-1',
        paymentMethod: 'mada',
        chargeDate: new Date(1744036133441),
        settlementDate: new Date(1744122533441),
        payoutDate: new Date(1744208933441),
      },
    ]);
  });

  it('empty optional cells become undefined (a charge not paid out yet has no payout id)', () => {
    const { rows } = parseChargeReport(
      `${HEADER}\n${line({ payout_id: '', settlement_id: '', settlement_date: '', payout_date: '', fee: '', fee_vat: '', net_amount: '' })}\n`,
    );
    expect(rows[0]).toMatchObject({ chargeId: 'chg_1', amount: 250 });
    expect(rows[0].payoutId).toBeUndefined();
    expect(rows[0].fee).toBeUndefined();
    expect(rows[0].payoutDate).toBeUndefined();
  });

  it('works with only the four required columns', () => {
    const { rows } = parseChargeReport(
      'charge_id,currency,amount,status\nchg_9,sar,10,captured\n',
    );
    expect(rows).toEqual([
      expect.objectContaining({
        chargeId: 'chg_9',
        currency: 'SAR',
        amount: 10,
        status: 'CAPTURED',
      }),
    ]);
  });

  it('column order does not matter and headers are case-insensitive', () => {
    const { rows } = parseChargeReport(
      'STATUS,Amount,CHARGE_ID,Currency\nCAPTURED,5.5,chg_2,KWD\n',
    );
    expect(rows[0]).toMatchObject({
      chargeId: 'chg_2',
      amount: 5.5,
      currency: 'KWD',
    });
  });

  it.each([['charge_id'], ['amount'], ['currency'], ['status']])(
    'REJECTS a file without the %s column — it is not a Tap charges report',
    (missing) => {
      const cols = ['charge_id', 'currency', 'amount', 'status'].filter(
        (c) => c !== missing,
      );
      expect(() =>
        parseChargeReport(
          `${cols.join(',')}\n${cols.map(() => 'x').join(',')}\n`,
        ),
      ).toThrow(/missing column/);
    },
  );

  it('skips and COUNTS rows it cannot trust instead of guessing', () => {
    const csv = [
      HEADER,
      line(), // good
      line({ charge_id: '' }), // no id
      line({ charge_id: 'chg 1; DROP' }), // hostile id
      line({ currency: 'SARR' }),
      line({ amount: 'abc' }),
      line({ status: '' }),
      'too,few,cells',
    ].join('\n');
    const { rows, skipped } = parseChargeReport(csv);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(6);
  });

  it('a header-only file and an empty file are valid and empty', () => {
    expect(parseChargeReport(`${HEADER}\n`)).toEqual({ rows: [], skipped: 0 });
    expect(parseChargeReport('')).toEqual({ rows: [], skipped: 0 });
  });

  it('a non-CSV blob (HTML error page) is rejected as a report', () => {
    expect(() => parseChargeReport('<html><body>502</body></html>')).toThrow(
      TapReportParseError,
    );
  });
});
