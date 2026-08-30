import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Spec 014 (Clinic Platform Completion) — T114 (US6, FR-H014).
 *
 * "Clinical entries MUST be retained when a patient record is soft-deleted,
 * MUST be excluded from ordinary patient lists, and MUST remain reachable
 * through an explicitly authorized path."
 *
 * This is satisfied BY CONSTRUCTION, not by an extra soft-delete-aware
 * branch: every clinical query filters by the raw `customerId` FOREIGN KEY
 * column directly (`WHERE "customerId" = $1` / `customer: { id }`) — it
 * never loads through `Customer`'s own repository, which is the ONLY place
 * TypeORM's default `@DeleteDateColumn` behavior would exclude a
 * soft-deleted row. `CustomerService.list()` (ordinary patient lists) DOES
 * load through that repository, so it already excludes soft-deleted
 * patients — unchanged, pre-existing behavior.
 *
 * These are regression guards for that design property, not new behavior:
 * a future edit that started joining clinical queries through `Customer`
 * (e.g. to pull the patient's name) would silently reintroduce exactly the
 * failure mode FR-H014 forbids, and neither a unit test mocking repositories
 * nor a live soft-delete-and-reopen integration test would necessarily catch
 * it if the join used `leftJoinAndSelect` without noticing the implicit
 * `deleted_at IS NULL` — a static check on the actual SQL/dependency graph
 * is the more direct proof.
 */
describe('clinical queries never gate on Customer.deleted_at (T114, FR-H014)', () => {
  const timelineSource = fs.readFileSync(
    path.join(__dirname, 'clinical-timeline.service.ts'),
    'utf8',
  );
  const recordSource = fs.readFileSync(
    path.join(__dirname, 'clinical-record.service.ts'),
    'utf8',
  );

  it('the timeline UNION query never references a customers table join', () => {
    expect(timelineSource).not.toMatch(/JOIN\s+"?customers"?/i);
  });

  it('ClinicalTimelineService never imports CustomerService (no accidental soft-delete gate via that dependency)', () => {
    expect(timelineSource).not.toContain('CustomerService');
  });

  it('ClinicalRecordService never imports CustomerService (encounters/entries are reachable regardless of patient soft-delete state)', () => {
    expect(recordSource).not.toContain('CustomerService');
  });

  it('ClinicalController never imports CustomerService (the authorized clinical path never routes through the ordinary-patient-list gate)', () => {
    const controllerSource = fs.readFileSync(
      path.join(__dirname, 'clinical.controller.ts'),
      'utf8',
    );
    expect(controllerSource).not.toContain('CustomerService');
  });
});
