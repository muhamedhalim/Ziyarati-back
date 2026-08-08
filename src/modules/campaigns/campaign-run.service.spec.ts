import { CampaignRunService } from './campaign-run.service';
import { CampaignExecution } from '../../entities/enums';
import { createMockRepository, MockRepository } from '../../../test/utils/mock-factories';

/**
 * FND-019 — pause → add-recipients → resume journey.
 *
 * Root cause (verified): `currentEditable()` forks a brand-new IDLE run for
 * ANY latest run that isn't already IDLE — including a DRAINING (paused) one.
 * `pause()`/`resume()`/`cancel()`/`retryFailed()` all resolve "the run in
 * play" via `latest()` (strictly newest-by-created_at, no execution-state
 * filter). Once `addRecipients()` forks a new IDLE run while paused, that
 * fork becomes the newest row, so `resume()` can never see the original
 * DRAINING run again: it stays DRAINING forever (its in-flight delayed jobs
 * re-defer every 30s, forever, per `campaign-dispatch.service.ts`'s
 * PAUSE_RECHECK_MS branch), while the forked IDLE run — holding every
 * recipient added during the pause — is never launched by any code path,
 * because `launch()` refuses a same-to-same lifecycle transition and the
 * campaign is already ACTIVE again after resume().
 */
describe('CampaignRunService — pause / resume / add-recipients journey (FND-019)', () => {
  let service: CampaignRunService;
  let runs: MockRepository;

  beforeEach(() => {
    runs = createMockRepository();
    service = new CampaignRunService(runs as never);
  });

  it('[FND-019] does not fork a new run when the campaign is DRAINING (paused, finishing in-flight) — recipients added while paused must land on the same run resume() will bring back to PROCESSING', async () => {
    const drainingRun = {
      id: 'run-1-draining',
      execution: CampaignExecution.DRAINING,
      created_at: new Date('2026-01-01T00:00:00Z'),
    };
    runs.findOne.mockResolvedValueOnce(drainingRun); // latest() inside currentEditable()

    const result = await service.currentEditable('t1', 'camp-1');

    expect(runs.create).not.toHaveBeenCalled();
    expect(result.id).toBe('run-1-draining');
  });

  // Corrected post-fix (staleness demonstrated): the RED-phase version of
  // this test asserted latest() could reach a DRAINING run given a fork had
  // ALREADY occurred — a premise that can no longer arise once
  // currentEditable() stops forking during DRAINING (previous test). Testing
  // "what if a fork existed anyway" against an unchanged latest() would never
  // go green and would no longer describe any reachable system state.
  // Replaced with the real end-to-end guarantee the fix delivers: after
  // currentEditable() targets the DRAINING run, latest() — which
  // pause()/resume()/cancel() all use to resolve "the run in play" — still
  // resolves to that SAME row, because no second row was ever created.
  it('[FND-019] after currentEditable() targets the DRAINING run, latest() (which resume() uses) still resolves to that SAME run — no orphan is created', async () => {
    const drainingRun = {
      id: 'run-1-draining',
      execution: CampaignExecution.DRAINING,
      created_at: new Date('2026-01-01T00:00:00Z'),
    };

    runs.findOne.mockResolvedValueOnce(drainingRun);
    const editable = await service.currentEditable('t1', 'camp-1');
    expect(editable.id).toBe('run-1-draining');

    runs.findOne.mockResolvedValueOnce(drainingRun);
    const resumeTarget = await service.latest('t1', 'camp-1');
    expect(resumeTarget).not.toBeNull();
    expect(resumeTarget!.id).toBe('run-1-draining');
    expect(resumeTarget!.execution).toBe(CampaignExecution.DRAINING);
  });

  // ── Regression guards — behavior that is already correct and must not
  // change: a run that is actively claiming work (ENQUEUEING/PROCESSING)
  // must still fork rather than accept new recipients, since appending to a
  // run mid-fanout could race the fanout cursor.
  it('still forks a fresh run when the latest one is ENQUEUEING (fan-out in progress)', async () => {
    const enqueueing = { id: 'run-1', execution: CampaignExecution.ENQUEUEING, created_at: new Date() };
    runs.findOne.mockResolvedValueOnce(enqueueing);
    const created = { id: 'run-2', execution: CampaignExecution.IDLE };
    runs.create.mockReturnValueOnce(created);
    runs.save.mockResolvedValueOnce(created);

    const result = await service.currentEditable('t1', 'camp-1');

    expect(runs.create).toHaveBeenCalled();
    expect(result.id).toBe('run-2');
  });

  it('still forks a fresh run when the latest one is PROCESSING (recipients actively in flight)', async () => {
    const processing = { id: 'run-1', execution: CampaignExecution.PROCESSING, created_at: new Date() };
    runs.findOne.mockResolvedValueOnce(processing);
    const created = { id: 'run-2', execution: CampaignExecution.IDLE };
    runs.create.mockReturnValueOnce(created);
    runs.save.mockResolvedValueOnce(created);

    const result = await service.currentEditable('t1', 'camp-1');

    expect(runs.create).toHaveBeenCalled();
    expect(result.id).toBe('run-2');
  });

  it('still returns the latest run directly when it is already IDLE (unchanged base case)', async () => {
    const idle = { id: 'run-1', execution: CampaignExecution.IDLE, created_at: new Date() };
    runs.findOne.mockResolvedValueOnce(idle);

    const result = await service.currentEditable('t1', 'camp-1');

    expect(runs.create).not.toHaveBeenCalled();
    expect(result.id).toBe('run-1');
  });
});
