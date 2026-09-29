/**
 * Spreadsheet formula-injection guard (SEC-05).
 *
 * Text that reaches a spreadsheet through an import (a patient name, a service
 * description, a partner-supplied field) is stored unchanged, but the moment
 * staff open an EXPORT in Excel/Sheets a cell beginning with `= + - @` (or a tab
 * / carriage return) is evaluated as a formula. The fix belongs at the export
 * boundary: prefix the cell with a single quote, which spreadsheets treat as
 * "this is text". Stored data is never altered.
 *
 * Mirrors the frontend's failed-rows CSV rule (`developer-failed-rows-csv.ts`)
 * so a value is escaped identically wherever it leaves the system.
 */

/** Always executable as a formula — always escaped. */
const ALWAYS_FORMULA = /^[=@\t\r]/;

/**
 * `+` / `-` also start a formula, but a value made only of digits and phone or
 * number punctuation (`+966 50 123 4567`, `-5`) cannot carry a payload, and
 * escaping it would corrupt every phone number on re-upload — so it passes.
 */
const SIGNED = /^[+-]/;
const NUMBER_LIKE = /^[+-]?[\d\s().-]+$/;

/** True when a spreadsheet would try to evaluate this text as a formula. */
export function isFormulaLike(text: string): boolean {
  if (ALWAYS_FORMULA.test(text)) return true;
  return SIGNED.test(text) && !NUMBER_LIKE.test(text);
}

/**
 * Escape ONE cell for export. Only strings can carry a formula, so numbers,
 * booleans, dates, null and undefined are returned untouched (an escaped number
 * would turn a numeric column into text).
 */
export function escapeSpreadsheetCell<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  return isFormulaLike(value) ? `'${value}` : value;
}

/** Escape every cell of a row object, preserving its keys. */
export function escapeSpreadsheetRow(
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = escapeSpreadsheetCell(value);
  }
  return out;
}
