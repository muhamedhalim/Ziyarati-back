/**
 * VER-007 (REQ-TEN-019, P1) — the `Patient` entity is DELIBERATELY exempt
 * from tenant isolation (Patient.ts's own docstring: "Deliberately
 * standalone: NO tenant relation... patients live in their own table and
 * never participate in the RBAC / multi-tenant model"). A B2C patient can
 * book across multiple clinics with one shared login, unlike `Customer`
 * (tenant-scoped per clinic, FND-040). The exemption must be honored at
 * EVERY read site — this walks the whole `src/` tree (mirrors
 * `rbac.constants.spec.ts`'s FND-010 convention) for every reference to the
 * `Patient` entity/repository, so a future addition can't silently introduce
 * either direction of bug: (a) a stray tenant filter that would break the
 * cross-clinic login the exemption exists for, or (b) a read that serves
 * back another patient's identity-bearing data without the request's own
 * authenticated identity gating it.
 *
 * Full-repo verification result (this file's own construction, not asserted
 * — recorded here since it IS the evidence): `Patient` has ZERO entity
 * relations anywhere (`@ManyToOne(() => Patient` / `: Patient` as a relation
 * type — grepped `src/entities/**`, no matches) and exactly ONE consumer,
 * `src/modules/auth/patient.service.ts`, with exactly ONE repository read
 * (`registerPatient`'s email-uniqueness `findOne`). No controller wires
 * `PatientService` to any route today (grepped for `PatientService`/
 * `RegisterPatientDto`/`registerPatient(` repo-wide — only the service and
 * its own spec reference it) — flagged separately, out of this finding's
 * scope (BEO-001 territory, not a Wave 4 item).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.join(__dirname, '..', '..');

function findTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      findTsFiles(full, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Every non-spec, non-module file that imports the Patient entity, relative
 * to src/. `.module.ts` files are excluded on principle, not convenience:
 * they can only ever contain `TypeOrmModule.forFeature([Patient])`-style DI
 * registration — structurally incapable of issuing a query — so counting
 * them would conflate "the repository is wired up" with "data is read".
 */
function scanPatientReferences(): string[] {
  const hits: string[] = [];
  for (const file of findTsFiles(SRC_ROOT)) {
    if (file.endsWith('.module.ts')) continue;
    if (file.includes(`${path.sep}entities${path.sep}Patients${path.sep}Patient`)) continue;
    const contents = fs.readFileSync(file, 'utf8');
    if (/from ['"][^'"]*entities\/Patients\/Patient['"]/.test(contents)) {
      hits.push(path.relative(SRC_ROOT, file).split(path.sep).join('/'));
    }
  }
  return hits.sort();
}

describe('Patient tenant-isolation exemption — every read site enumerated (VER-007)', () => {
  const REFERENCING_FILES = scanPatientReferences();

  it('the ONLY non-spec, non-module file importing the Patient entity is patient.service.ts — no other read/write site exists anywhere in src/', () => {
    expect(REFERENCING_FILES).toEqual(['modules/auth/patient.service.ts']);
  });

  it('auth.module.ts really does register Patient via plain TypeOrmModule.forFeature DI wiring (proves the exclusion above is principled, not a blind spot)', () => {
    const moduleSrc = fs.readFileSync(path.join(SRC_ROOT, 'modules', 'auth', 'auth.module.ts'), 'utf8');
    expect(moduleSrc).toMatch(/TypeOrmModule\.forFeature\(\[[\s\S]*?\bPatient\b[\s\S]*?\]\)/);
  });

  it('Patient has NO relation from any other entity (the isolation is structural, not just query-discipline)', () => {
    const entitiesRoot = path.join(SRC_ROOT, 'entities');
    const violators: string[] = [];
    for (const file of findTsFiles(entitiesRoot)) {
      if (file.endsWith(`${path.sep}Patient.ts`)) continue;
      const contents = fs.readFileSync(file, 'utf8');
      if (/@(ManyToOne|OneToMany|OneToOne|ManyToMany)\(\(\) => Patient\b/.test(contents)) {
        violators.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violators).toEqual([]);
  });

  it("patient.service.ts's one repository read (email-uniqueness check) carries NO tenant/scoping predicate — correctly global, matching the entity's own global unique index", () => {
    const serviceSrc = fs.readFileSync(
      path.join(SRC_ROOT, 'modules', 'auth', 'patient.service.ts'),
      'utf8',
    );
    // Non-greedy up to the call's closing `});` — safe here because this file
    // has exactly one `this.patients.findOne(...)` call site (asserted next).
    const callSites = serviceSrc.match(/this\.patients\.findOne\([\s\S]*?\}\);/g) ?? [];
    expect(callSites).toHaveLength(1);
    const argsBody = callSites[0];
    expect(argsBody).toContain('email');
    expect(argsBody).not.toMatch(/tenant/i);
  });
});
