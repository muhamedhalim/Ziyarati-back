/**
 * Side-effect module, imported right AFTER `tap-e2e-env.setup` and BEFORE anything
 * that pulls AppModule: switches on saved-card / merchant-initiated renewals
 * (`TAP_RECURRING_ENABLED`). Separate from the base setup because the Phase 2 specs
 * run with it OFF, and `ConfigModule` caches `process.env` when `app.module.ts` is
 * first required — so it cannot be flipped from inside a spec.
 */
process.env.TAP_RECURRING_ENABLED = 'true';
