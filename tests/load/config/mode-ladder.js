/**
 * Sets the step-tagging mode BEFORE any other module reads it. Import this FIRST in a
 * scenario file (ES imports evaluate in order): helpers/buckets.js registers its
 * per-step histogram counters at import time from LT_MODE.
 */
if (!__ENV.LT_MODE) __ENV.LT_MODE = 'ladder';
