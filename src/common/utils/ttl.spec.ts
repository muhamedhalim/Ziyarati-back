import { ttlToMs } from './ttl';

describe('ttlToMs', () => {
  it('treats a number as seconds', () => {
    expect(ttlToMs(900)).toBe(900_000);
  });

  it.each([
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('parses "%s" with its unit', (input, expected) => {
    expect(ttlToMs(input)).toBe(expected);
  });

  it('treats a bare number string as seconds', () => {
    expect(ttlToMs('900')).toBe(900_000);
  });

  it('tolerates surrounding whitespace', () => {
    expect(ttlToMs('  15m ')).toBe(900_000);
  });

  it.each([undefined, '', '0', 0])('returns 0 for falsy input %p', (input) => {
    expect(ttlToMs(input as any)).toBe(0);
  });

  it('returns 0 for an unparseable value', () => {
    expect(ttlToMs('not-a-ttl')).toBe(0);
  });
});
