import { WorkflowProcessor } from './workflow.processor';
import { WorkflowService } from '../../modules/workflow/workflow.service';
import { WorkflowActionExecutor } from '../../modules/workflow/workflow-action.executor';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { JOB } from '../../queue/queue.constants';

describe('WorkflowProcessor.handleAction — already-terminal guard (gap-closure pass, §0.8.11 / H8)', () => {
  const action = { type: 'EMAIL', config: {}, conditions: undefined };
  const workflow = { id: 'wf-1', actions: [action] };

  const build = (existingResults: Array<{ index: number; status: string; detail?: string }>) => {
    const workflows = {
      getRunWithWorkflow: jest.fn().mockResolvedValue({
        run: { id: 'run-1', context: {}, results: existingResults },
        workflow,
      }),
      evaluateConditions: jest.fn().mockReturnValue(true),
      appendResult: jest.fn().mockResolvedValue(undefined),
      finalizeRun: jest.fn().mockResolvedValue(undefined),
      markRunning: jest.fn().mockResolvedValue(undefined),
    };
    const executor = { execute: jest.fn().mockResolvedValue({ status: 'SUCCEEDED', detail: 'sent' }) };
    const queue = { enqueueWorkflowAction: jest.fn() };
    const ctx = new TenantContextService();
    const authz = { assertAuthorized: jest.fn().mockResolvedValue(undefined) };
    const processor = new WorkflowProcessor(
      workflows as unknown as WorkflowService,
      executor as unknown as WorkflowActionExecutor,
      queue as unknown as QueueService,
      ctx,
      authz as unknown as WorkerAuthorizationService,
    );
    return { processor, workflows, executor };
  };

  const actionJob = () => ({
    name: JOB.WORKFLOW_ACTION,
    data: { tenantId: 't1', runId: 'run-1', actionIndex: 0 },
  } as any);

  it('executes the action when no prior result exists', async () => {
    const { processor, executor } = build([]);
    const res = await processor.process(actionJob());
    expect(executor.execute).toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('SKIPS re-execution when the action already SUCCEEDED — the double-send this fix prevents', async () => {
    const { processor, executor } = build([{ index: 0, status: 'SUCCEEDED', detail: 'sent earlier' }]);
    const res = await processor.process(actionJob());
    expect(executor.execute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'SUCCEEDED', detail: 'sent earlier' });
  });

  it('SKIPS re-execution when the action was already SKIPPED (conditions previously didn\'t match)', async () => {
    const { processor, executor } = build([{ index: 0, status: 'SKIPPED', detail: 'conditions not met' }]);
    const res = await processor.process(actionJob());
    expect(executor.execute).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'SKIPPED' });
  });

  it('DOES re-execute when the prior result was FAILED — a legitimate retry must still run', async () => {
    const { processor, executor } = build([{ index: 0, status: 'FAILED', detail: 'timeout' }]);
    await processor.process(actionJob());
    expect(executor.execute).toHaveBeenCalled();
  });

  it('a result for a DIFFERENT actionIndex does not block this one', async () => {
    const { processor, executor } = build([{ index: 1, status: 'SUCCEEDED' }]);
    await processor.process(actionJob());
    expect(executor.execute).toHaveBeenCalled();
  });
});
