/**
 * API route manifest (Phase 3, CR-05 class).
 *
 * `test/contract/routes.manifest.json` is the list of every HTTP route the backend mounts, relative to the
 * `/api/v1` global prefix, with path parameters normalised to `:param`. The frontend keeps a copy and checks
 * every API call it makes against it (`app/contract/api-contract.test.ts` in the frontend repo), which is what
 * would have caught the Contact Us form posting to a route that did not exist.
 *
 * This spec is the backend half: it fails when the live route set and the committed manifest differ, so a
 * route cannot be added, renamed or removed without the manifest (and therefore the frontend's copy) moving
 * with it. Regenerate after an intentional change with:
 *
 *   UPDATE_ROUTE_MANIFEST=1 npx jest --config ./test/jest-security.json test/security/route-manifest.spec.ts
 *
 * Infrastructure-free: it reads framework metadata through `nest-route-metadata.ts`, never source text.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { collectMountedRoutes } from './nest-route-metadata';

const MANIFEST_PATH = join(__dirname, '..', 'contract', 'routes.manifest.json');

/** `/appointments/:id/cancel` and `/appointments/:appointmentId/cancel` are the same route to a caller. */
export function normalisePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, ':param');
}

describe('API route manifest', () => {
  let live: string[];

  beforeAll(async () => {
    const routes = await collectMountedRoutes();
    live = Array.from(
      new Set(routes.map((r) => `${r.httpMethod.toUpperCase()} ${normalisePath(r.path)}`)),
    ).sort();
  }, 60_000);

  it('sees a non-trivial route surface (the harness did not silently discover almost nothing)', () => {
    expect(live.length).toBeGreaterThan(500);
  });

  it('matches the committed manifest exactly (run with UPDATE_ROUTE_MANIFEST=1 after an intentional change)', () => {
    if (process.env.UPDATE_ROUTE_MANIFEST === '1') {
      mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
      writeFileSync(MANIFEST_PATH, JSON.stringify({ routes: live }, null, 2) + '\n', 'utf8');
      return;
    }
    const committed: string[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).routes;
    const added = live.filter((r) => !committed.includes(r));
    const removed = committed.filter((r) => !live.includes(r));
    if (added.length || removed.length) {
      throw new Error(
        'The mounted routes differ from test/contract/routes.manifest.json.\n' +
          (added.length ? `  added (not in the manifest):\n${added.map((r) => `    + ${r}`).join('\n')}\n` : '') +
          (removed.length ? `  removed (still in the manifest):\n${removed.map((r) => `    - ${r}`).join('\n')}\n` : '') +
          'Regenerate with UPDATE_ROUTE_MANIFEST=1 and copy the file to the frontend repo ' +
          '(contract/backend-routes.json) so its API contract test sees the change.',
      );
    }
  });
});
