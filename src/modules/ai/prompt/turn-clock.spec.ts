import { describeToday } from './turn-clock';

describe('describeToday', () => {
  // 21:30 UTC on Tue 6 Oct 2026: already Wed 7 Oct in Riyadh (UTC+3).
  const NOW = new Date('2026-10-06T21:30:00Z');

  it('states the date and weekday in the given zone, not the server’s', () => {
    expect(describeToday('Asia/Riyadh', NOW)).toContain(
      'today: 2026-10-07 (Wednesday, Asia/Riyadh)',
    );
    expect(describeToday('America/Los_Angeles', NOW)).toContain(
      'today: 2026-10-06 (Tuesday, America/Los_Angeles)',
    );
  });

  it('defaults to UTC when no zone is given', () => {
    expect(describeToday(undefined, NOW)).toContain('(Tuesday, UTC)');
    expect(describeToday(null, NOW)).toContain('(Tuesday, UTC)');
    expect(describeToday('  ', NOW)).toContain('(Tuesday, UTC)');
  });

  it('an unrecognised zone costs the zone, never the line', () => {
    const line = describeToday('Not/AZone', NOW);
    expect(line).toContain('today: 2026-10-06');
  });

  it('tells the model to resolve relative dates from it and to emit YYYY-MM-DD', () => {
    const line = describeToday('UTC', NOW);
    expect(line).toContain('never from memory');
    expect(line).toContain('YYYY-MM-DD');
  });
});
