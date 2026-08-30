import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Spec 014 (Clinic Platform Completion) — T098 regression guard.
 *
 * `nest build` only compiles `.ts` files; it does NOT copy non-TS assets
 * (fonts, images, etc.) unless `compilerOptions.assets` names them in
 * `nest-cli.json`. `DocumentRendererService` (T021) loads two embedded
 * `.woff` fonts by a path relative to its own compiled location — without
 * this config, EVERY invoice/report document render fails in a real
 * deployment (only `dist/` ships, not `src/`), a failure jest's own
 * ts-jest-against-source unit tests can never catch since they never touch
 * `dist/` at all. Found empirically while rendering a real sample document
 * for T098 — `nest build` had silently produced a `dist/` with no
 * `fonts/` directory at all.
 */
describe('nest-cli.json — documents fonts are copied into dist (T098)', () => {
  const repoRoot = path.join(__dirname, '..', '..', '..');

  it('declares an assets entry covering modules/documents/fonts', () => {
    const raw = fs.readFileSync(path.join(repoRoot, 'nest-cli.json'), 'utf8');
    const config = JSON.parse(raw);
    const assets: Array<{ include?: string; outDir?: string }> =
      config?.compilerOptions?.assets ?? [];
    const fontsEntry = assets.find((a) =>
      (a.include ?? '').includes('modules/documents/fonts'),
    );
    expect(fontsEntry).toBeDefined();
  });

  it('the source font files this config must copy actually exist', () => {
    const fontsDir = path.join(__dirname, 'fonts');
    const files = fs.readdirSync(fontsDir);
    expect(files.some((f) => f.endsWith('.woff'))).toBe(true);
  });
});
