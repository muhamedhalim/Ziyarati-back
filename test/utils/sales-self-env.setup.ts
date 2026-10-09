/**
 * MUST be the first import of `platform-sales-self.e2e-spec.ts`.
 *
 * The spec creates sales employees WITH an invitation (the whole point is to
 * prove invite -> accept -> login). `.env` on a developer machine can carry a
 * live mail-provider key with `EMAIL_ENABLED=true`; a test must never send a
 * real email, so mail is forced off before the app is ever built. The raw
 * invitation token is captured from `AuthService.issuePasswordSetupToken`
 * instead of from an inbox.
 */
process.env.EMAIL_ENABLED = 'false';
