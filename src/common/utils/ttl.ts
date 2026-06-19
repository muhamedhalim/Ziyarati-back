/**
 * Parse a short TTL string (e.g. "15m", "7d", "900s", "2h") into milliseconds.
 * Falls back to treating a bare number as seconds. Used for cookie Max-Age so
 * cookie lifetimes stay in lock-step with the JWT TTLs.
 */
export function ttlToMs(ttl: string | number | undefined): number {
  if (typeof ttl === 'number') return ttl * 1000;
  if (!ttl) return 0;

  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(ttl.trim());
  if (!match) return 0;

  const value = Number(match[1]);
  const unit = match[2] ?? 's';

  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}
