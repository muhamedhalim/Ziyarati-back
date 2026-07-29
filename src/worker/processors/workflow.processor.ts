import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { JOB, QUEUE, workerConcurrency } from '../../queue/queue.constants';
import { QueueService } from '../../queue/queue.service';
import { WorkflowActionJob, WorkflowRunJob } from '../../queue/job-data.interface';
import { runInTenantContext } from '../../queue/tenant-context.runner';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { WorkflowService } from '../../modules/workflow/workflow.service';
import { WorkflowActionExecutor } from '../../modules/workflow/workflow-action.executor';

/**
 * Consumes the `workflow` queue.
 *
 *  - `workflow.run`    → load the run + workflow, mark RUNNING, and fan each
 *    action out into its own delayed `workflow.action` job (per-action delay).
 *  - `workflow.action` → execute ONE action via WorkflowActionExecutor (which
 *    reuses Email/WhatsApp/Notification/AI services), record the outcome, and
 *    finalize the run once every action has reported.
 *
 * Retry + backoff come from the queue's default job options; a failed action job
 * is retried by BullMQ, and its outcome is recorded on the run for audit.
 */
@Processor(QUEUE.WORKFLOW, { concurrency: workerConcurrency() })
export class WorkflowProcessor extends WorkerHost {
  private readonly logger = new Logger('WorkflowProcessor');

  constructor(
    private readonly workflows: WorkflowService,
    private readonly executor: WorkflowActionExecutor,
    private readonly queue: QueueService,
    private readonly ctx: TenantContextService,
    private readonly authz: WorkerAuthorizationService,
  ) {
    super();
  }

  async process(job: Job<WorkflowRunJob | WorkflowActionJob>) {
    if (job.name === JOB.WORKFLOW_RUN) return this.handleRun(job as Job<WorkflowRunJob>);
    if (job.name === JOB.WORKFLOW_ACTION) return this.handleAction(job as Job<WorkflowActionJob>);
    this.logger.warn(`unknown workflow job "${job.name}"`);
    return undefined;
  }

  private async handleRun(job: Job<WorkflowRunJob>) {
    const { tenantId, runId } = job.data;
    return runInTenantContext(this.ctx, this.authz, job.name, job.data, async () => {
      const loaded = await this.workflows.getRunWithWorkflow(runId);
      if (!loaded) {
        this.logger.warn(`workflow run ${runId} not found — skipping`);
        return { skipped: true };
      }
      const { workflow } = loaded;
      await this.workflows.markRunning(runId);

      const actions = workflow.actions ?? [];
      for (let i = 0; i < actions.length; i += 1) {
        const delayMs = Math.max(0, (actions[i].delayMinutes ?? 0) * 60_000);
        await this.queue.enqueueWorkflowAction({ tenantId, runId, actionIndex: i }, { delay: delayMs });
      }
      this.logger.log(`workflow run ${runId} fanned out ${actions.length} action(s)`);
      return { actions: actions.length };
    });
  }

  private async handleAction(job: Job<WorkflowActionJob>) {
    const { tenantId, runId, actionIndex } = job.data;
    return runInTenantContext(this.ctx, this.authz, job.name, job.data, async () => {
      const loaded = await this.workflows.getRunWithWorkflow(runId);
      if (!loaded) return { skipped: true };
      const { run, workflow } = loaded;
      const action = (workflow.actions ?? [])[actionIndex];
      if (!action) return { skipped: true };

      // ALREADY-TERMINAL guard (gap-closure pass — see
      // docs/CACHING_QUEUES_AUDIT.md §0.8.11 / original audit H8):
      // `appendResult` already dedupes the RESULTS BOOKKEEPING per actionIndex
      // (a repeat call replaces, not duplicates, the entry), but nothing
      // previously stopped `executor.execute` — the REAL side effect
      // (email/WhatsApp/webhook send) — from running again. A manual retry
      // racing a BullMQ auto-retry, or a stalled job redelivered after the
      // action already succeeded, would double-send. A `FAILED` result is
      // NOT terminal here — that's exactly what a legitimate retry needs to
      // re-attempt.
      const existing = (run.results ?? []).find((r) => r.index === actionIndex);
      if (existing && existing.status !== 'FAILED') {
        this.logger.log(`workflow run ${runId} action ${actionIndex} already ${existing.status} — skipping duplicate execution`);
        return { status: existing.status, detail: existing.detail };
      }

      // Per-action gate (IF/ELSE branching in the visual builder): reuses the
      // SAME evaluator the workflow-level `conditions` use — no second engine.
      if (!this.workflows.evaluateConditions(action.conditions, run.context ?? {})) {
        await this.workflows.appendResult(runId, {
          index: actionIndex,
          type: action.type,
          status: 'SKIPPED',
          detail: 'Action conditions did not match the run context.',
          at: new Date().toISOString(),
        });
        await this.workflows.finalizeRun(runId, (workflow.actions ?? []).length);
        return { skipped: true };
      }

      const outcome = await this.executor.execute(tenantId, runId, action, run.context ?? {});
      await this.workflows.appendResult(runId, {
        index: actionIndex,
        type: action.type,
        status: outcome.status,
        detail: outcome.detail,
        at: new Date().toISOString(),
      });
      await this.workflows.finalizeRun(runId, (workflow.actions ?? []).length);

      // Surface a hard failure to BullMQ so it retries per the default backoff.
      if (outcome.status === 'FAILED') {
        throw new Error(`action ${actionIndex} (${action.type}) failed: ${outcome.detail ?? 'unknown'}`);
      }
      return outcome;
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    this.logger.error(`${job?.name} job=${job?.id} FAILED (attempt ${job?.attemptsMade}): ${err?.message}`);
  }
}
