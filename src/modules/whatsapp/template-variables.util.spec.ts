import { extractRequiredVariables, missingVariables } from './template-variables.util';

const withBody = (text: string) => ({ components: [{ type: 'BODY', text }] });

describe('extractRequiredVariables', () => {
  it('extracts every distinct {{n}} placeholder in the BODY component', () => {
    expect(extractRequiredVariables(withBody('Hi {{1}}, your appointment is on {{2}}.'))).toEqual(['1', '2']);
  });

  it('de-duplicates a repeated placeholder', () => {
    expect(extractRequiredVariables(withBody('{{1}} confirmed. See you, {{1}}!'))).toEqual(['1']);
  });

  it('returns empty for a template with no placeholders', () => {
    expect(extractRequiredVariables(withBody('Thanks for visiting us!'))).toEqual([]);
  });

  it('returns empty when there is no BODY component, or no components at all', () => {
    expect(extractRequiredVariables({ components: [{ type: 'HEADER', text: 'Hi {{1}}' }] })).toEqual([]);
    expect(extractRequiredVariables(undefined)).toEqual([]);
    expect(extractRequiredVariables(null)).toEqual([]);
    expect(extractRequiredVariables({})).toEqual([]);
  });
});

describe('missingVariables', () => {
  const TEMPLATE = withBody('Hi {{1}}, your appointment is on {{2}}.');

  it('lists every required placeholder when variables is undefined', () => {
    expect(missingVariables(TEMPLATE, undefined)).toEqual(['1', '2']);
  });

  it('lists only the missing ones when some are supplied', () => {
    expect(missingVariables(TEMPLATE, { '1': 'Sara' })).toEqual(['2']);
  });

  it('treats an empty/blank supplied value as still missing', () => {
    expect(missingVariables(TEMPLATE, { '1': 'Sara', '2': '   ' })).toEqual(['2']);
  });

  it('is empty when every placeholder is supplied', () => {
    expect(missingVariables(TEMPLATE, { '1': 'Sara', '2': '2026-06-15 10:00' })).toEqual([]);
  });

  it('is empty for a template with no placeholders, regardless of variables', () => {
    expect(missingVariables(withBody('No placeholders here.'), undefined)).toEqual([]);
  });
});
