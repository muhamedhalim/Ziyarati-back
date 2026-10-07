/**
 * The "what day is it" line every patient-facing AI turn carries.
 *
 * The model has no clock. Asked for "tomorrow" it produces a date from its
 * training data — observed live as a `search_public_availability` call for
 * `2023-10-29`, which returned no windows, after which the assistant told the
 * visitor there was nothing available. The clinic, branch and doctor were all
 * correct; only the day was invented. The server knows the date, so the server
 * states it, in the timezone the availability engine reads a `date` in (the
 * BRANCH's, not the patient's).
 *
 * Pure and dependency-free so the public widget's pinned block and the
 * WhatsApp one are guaranteed to say the same thing.
 */
export function describeToday(
  timezone?: string | null,
  now: Date = new Date(),
): string {
  const zone = timezone?.trim() || 'UTC';
  let date: string;
  try {
    date = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    // An unrecognised IANA zone must not cost the whole block.
    date = now.toISOString().slice(0, 10);
  }
  const weekday = (() => {
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        weekday: 'long',
      }).format(now);
    } catch {
      return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(now);
    }
  })();
  return `today: ${date} (${weekday}, ${zone}). Resolve "today", "tomorrow" and every other relative date from THIS, never from memory, and pass the result as YYYY-MM-DD.`;
}
