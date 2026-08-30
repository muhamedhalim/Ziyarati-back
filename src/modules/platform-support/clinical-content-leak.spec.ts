import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Spec 014 (Clinic Platform Completion) — T109 (US6, FR-H012).
 *
 * "Clinical content MUST NOT appear in any... platform-operator surface."
 * A static scan of every platform-support service file's SOURCE for the 4
 * clinical field names — proving the absence by test, not by inspection
 * alone, and (unlike inspecting one file) guarding against a FUTURE
 * platform-support file quietly starting to select one of them.
 *
 * Deliberately a text scan, not a runtime projection check: these services
 * build their responses via hand-picked column lists (see
 * `clinic-support-profile.service.ts`'s own docblock — "built by MAPPING
 * selected columns, never by serialising an entity and deleting fields"),
 * so the field name itself appearing anywhere in the file IS the signal —
 * there is no other way these services could reach `CustomerProfile`'s
 * clinical columns.
 */
describe('platform-support — no clinical field is ever selected (T109, FR-H012)', () => {
  const CLINICAL_FIELDS = ['medical_history', 'allergies', 'blood_type'];
  // 'notes' is deliberately excluded from the scan on its own — too generic
  // a word to scan as a bare string (matches unrelated things like a
  // ticket's own note fields). CustomerProfile.notes is covered by the
  // CustomerProfile-import check below instead.

  const dir = path.join(__dirname);
  const serviceFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.service.ts'));

  it('found at least one platform-support service file to scan (sanity — a passing empty scan proves nothing)', () => {
    expect(serviceFiles.length).toBeGreaterThan(0);
  });

  it.each(serviceFiles)('%s selects no clinical field by name', (file) => {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const field of CLINICAL_FIELDS) {
      expect(content).not.toContain(field);
    }
  });

  it.each(serviceFiles)(
    '%s never imports CustomerProfile (the entity carrying the clinical fields)',
    (file) => {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(content).not.toMatch(/CustomerProfile/);
    },
  );
});
