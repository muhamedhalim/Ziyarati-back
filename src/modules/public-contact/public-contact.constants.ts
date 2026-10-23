/**
 * Per-IP ceiling for `POST /public/contact`. An anonymous form that writes a row and sends an email
 * to staff is an easy spam/mail-bomb target, so it is far tighter than the global 300/min default.
 * Behind the Vercel proxy the "IP" is the forwarded client address once the edge token (RL-01) is
 * live; until then the bucket is shared, which only errs toward refusing more.
 */
export const PUBLIC_CONTACT_LIMIT = 5;

export const PUBLIC_CONTACT_THROTTLE = {
  default: {
    limit: process.env.NODE_ENV === 'test' ? 1_000_000 : PUBLIC_CONTACT_LIMIT,
    ttl: 60_000,
  },
};

/** An identical (email, message) enquiry inside this window is a double-submit, not a new lead. */
export const CONTACT_DUPLICATE_WINDOW_MS = 10 * 60_000;
