import { isOptOutMessage, parseOptOutKeywords } from './opt-out.util';

const KEYWORDS = 'stop,unsubscribe,cancel,opt out,optout,إلغاء,إيقاف,توقف,الغاء الاشتراك';

describe('isOptOutMessage (FND-024)', () => {
  it('matches the exact keyword regardless of case', () => {
    expect(isOptOutMessage('stop', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('STOP', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('Stop', KEYWORDS)).toBe(true);
  });

  it('matches with surrounding/extra whitespace', () => {
    expect(isOptOutMessage('  stop  ', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('stop\n', KEYWORDS)).toBe(true);
  });

  it('matches with trailing punctuation', () => {
    expect(isOptOutMessage('stop!', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('stop.', KEYWORDS)).toBe(true);
  });

  it('matches Arabic opt-out terms', () => {
    expect(isOptOutMessage('إلغاء', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('توقف', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('  إيقاف  ', KEYWORDS)).toBe(true);
  });

  it('matches a multi-word keyword exactly', () => {
    expect(isOptOutMessage('opt out', KEYWORDS)).toBe(true);
    expect(isOptOutMessage('Opt   Out', KEYWORDS)).toBe(true); // collapsed internal whitespace
  });

  it('does NOT match a sentence that merely contains a keyword-shaped word (exact match only, not substring)', () => {
    expect(isOptOutMessage('please stop calling me at odd hours, thanks', KEYWORDS)).toBe(false);
    expect(isOptOutMessage('I want to cancel my appointment tomorrow', KEYWORDS)).toBe(false);
  });

  it('does NOT match unrelated content', () => {
    expect(isOptOutMessage('Hi, what time do you open?', KEYWORDS)).toBe(false);
    expect(isOptOutMessage('', KEYWORDS)).toBe(false);
  });

  it('reflects keyword-set changes without any code change (data, not hardcoded)', () => {
    expect(isOptOutMessage('quit', KEYWORDS)).toBe(false);
    expect(isOptOutMessage('quit', `${KEYWORDS},quit`)).toBe(true);
  });
});

describe('parseOptOutKeywords', () => {
  it('normalizes, trims, and de-duplicates', () => {
    expect(parseOptOutKeywords('Stop, STOP , stop')).toEqual(['stop']);
  });

  it('drops empty entries from trailing/double commas', () => {
    expect(parseOptOutKeywords('stop,,cancel,')).toEqual(['stop', 'cancel']);
  });
});
