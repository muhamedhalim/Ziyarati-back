/**
 * ONE-OFF operational script — contract C11 (T096). Mints the single
 * platform-level API key the ZiyaraTech Marketplace uses to authenticate its
 * server-rendered discovery reads for elevated, per-visitor throttling
 * (`MarketplaceThrottlerGuard`). Boots the real Nest DI container so it goes
 * through the real `ApiKeyService.createPlatformKey()` — same validation,
 * same audit trail, same entity — rather than writing to `api_keys` directly.
 *
 * The resulting key:
 *   - `tenant` is NULL (platform-level — see the ApiKey entity's own comment).
 *   - carries exactly one scope, `marketplace:discovery`, which grants nothing
 *     else: it is deliberately absent from INTEGRATION_SCOPE_REQUIRES, so it
 *     can never be requested through the ordinary tenant-scoped
 *     `POST /platform/api-keys` route — only this script can issue it.
 *   - is authenticated by `ApiKeyAuthGuard`'s existing logic (X-API-Key /
 *     Authorization: ApiKey), but `MarketplaceThrottlerGuard` is the ONLY
 *     guard that reads it — it grants no tenant context, no route access
 *     beyond the public discovery reads that guard elevates.
 *
 * The plaintext is printed to stdout EXACTLY ONCE and is never stored or
 * retrievable again (same guarantee as any other API key). Copy it directly
 * into the Marketplace's server-side `MARKETPLACE_API_KEY` environment
 * variable (Vercel project settings) — never into a client-visible one, never
 * into a repo file.
 *
 * Rotation: re-run this script to mint a second key, update
 * `MARKETPLACE_API_KEY` to the new value, allow overlap while the new value
 * propagates, then deactivate the old key's row (`is_active=false`) via the
 * standard platform admin tooling or a follow-up script — never delete the
 * row outright (audit history).
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register scripts/mint-marketplace-api-key.ts ["key name"]
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ApiKeyService } from '../src/modules/platform/api-key.service';
import { INTEGRATION_SCOPE } from '../src/modules/platform/integration-scopes.constants';

async function main() {
  const name = process.argv[2] ?? 'ZiyaraTech Marketplace — discovery';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const apiKeys = app.get(ApiKeyService);

    const { apiKey, id, key_prefix } = await apiKeys.createPlatformKey(
      { name, permissions: [INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY] },
      { isSuperAdmin: true },
    );

    console.log('\n=== Marketplace platform API key minted ===');
    console.log(`id:         ${id}`);
    console.log(`key_prefix: ${key_prefix}`);
    console.log(`scope:      ${INTEGRATION_SCOPE.MARKETPLACE_DISCOVERY}`);
    console.log('\nPlaintext (copy this into MARKETPLACE_API_KEY now — shown once):');
    console.log(apiKey);
    console.log('');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Failed to mint Marketplace API key:', err);
  process.exitCode = 1;
});
