import { getAppRevision } from './app-revision.util';

describe('getAppRevision', () => {
  it('returns a valid short or full commit sha, lower-cased', () => {
    expect(getAppRevision({ APP_REVISION: '4ce6770' } as NodeJS.ProcessEnv)).toBe('4ce6770');
    expect(getAppRevision({ APP_REVISION: '4CE67707092FF77A1C24651C4425F3E8104DA82C' } as NodeJS.ProcessEnv)).toBe(
      '4ce67707092ff77a1c24651c4425f3e8104da82c',
    );
  });

  it.each([undefined, '', 'main', 'v1.2.3', '4ce677', 'x'.repeat(40), '4ce6770\r\nSet-Cookie: a=b', 'sk_live_abcdef1234567890', 'a'.repeat(41)])(
    'returns "unknown" for %j',
    (v) => {
      expect(getAppRevision({ APP_REVISION: v } as NodeJS.ProcessEnv)).toBe('unknown');
    },
  );
});
