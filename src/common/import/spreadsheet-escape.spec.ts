import {
  escapeSpreadsheetCell,
  escapeSpreadsheetRow,
  isFormulaLike,
} from './spreadsheet-escape';

describe('spreadsheet formula-injection escape (SEC-05)', () => {
  it.each([
    ['=HYPERLINK("http://evil","x")'],
    ['=1+1'],
    ['@SUM(A1:A2)'],
    ['\tcmd'],
    ['\rcmd'],
    ['+cmd|" /C calc"!A0'],
    ['-2+3+cmd|" /C calc"!A0'],
    ['-cmd'],
  ])('prefixes a formula-looking cell %j with a single quote', (input) => {
    expect(escapeSpreadsheetCell(input)).toBe(`'${input}`);
  });

  it.each([
    ['Sara Ahmed'],
    [''],
    ['a=b'],
    ['name@example.com'],
    ['100'],
    ['  =leading space is not a formula start'],
  ])('leaves ordinary text %j untouched', (input) => {
    expect(escapeSpreadsheetCell(input)).toBe(input);
  });

  it.each([
    ['+966 50 123 4567'],
    ['+966501234567'],
    ['-5'],
    ['(011) 555-0100'],
    ['-12.5'],
  ])('does not corrupt the phone/number-like value %j', (input) => {
    expect(isFormulaLike(input)).toBe(false);
    expect(escapeSpreadsheetCell(input)).toBe(input);
  });

  it('never touches non-strings (a numeric column must stay numeric)', () => {
    const date = new Date();
    expect(escapeSpreadsheetCell(-5)).toBe(-5);
    expect(escapeSpreadsheetCell(true)).toBe(true);
    expect(escapeSpreadsheetCell(null)).toBeNull();
    expect(escapeSpreadsheetCell(undefined)).toBeUndefined();
    expect(escapeSpreadsheetCell(date)).toBe(date);
  });

  it('escapes every cell of a row and preserves keys and non-string values', () => {
    expect(
      escapeSpreadsheetRow({
        name: '=cmd()',
        phone: '+966501234567',
        age: 30,
        note: null,
      }),
    ).toEqual({ name: "'=cmd()", phone: '+966501234567', age: 30, note: null });
  });

  it('does not mutate its input', () => {
    const row = { name: '=cmd()' };
    escapeSpreadsheetRow(row);
    expect(row.name).toBe('=cmd()');
  });
});
