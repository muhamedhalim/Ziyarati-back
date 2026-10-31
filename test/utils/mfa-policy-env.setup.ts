/**
 * Turns both MFA enforcement dates ON before AppModule is first required (the config
 * snapshot is frozen at import time — same mechanism as `auth-refresh-env.setup.ts`).
 */
process.env.MFA_ENFORCE_FROM = '2000-01-01';
process.env.MFA_ENFORCE_CLINICAL_FROM = '2000-01-01';

export {};
