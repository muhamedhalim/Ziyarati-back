import { WorkflowProcessor } from './workflow.processor';
import { WorkflowService } from '../../modules/workflow/workflow.service';
import { WorkflowActionExecutor } from '../../modules/workflow/workflow-action.executor';
import { QueueService } from '../../queue/queue.service';
import { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import { WorkerAuthorizationService } from '../../queue/worker-authorization.service';
import { JOB } from '../../queue/queue.constants';

describe('WorkflowProcessor.handleAction — atomic claim (gap-closure pass, §0.8.3)', () => {
  const action = { type: 'EMAIL', config: {}, conditions: undefined };
  const workflow = { id: 'wf-1', actions: [action] };

  const build = (claimResult: boolean) => {
    const workflows = {
      getRunWithWorkflow: jest.fn().mockResolvedValue({
        run: { id: 'run-1', context: {}, results: [] },
        workflow,
      }),
      evaluateConditions: jest.fn().mockReturnValue(true),
      claimAction: jest.fn().mockResolvedValue(claimResult),
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

  it('claims the action, then executes it, when the claim succeeds', async () => {
    const { processor, workflows, executor } = build(true);
    const res = await processor.process(actionJob());
    expect(workflows.claimAction).toHaveBeenCalledWith('run-1', 0, 'EMAIL');
    expect(executor.execute).toHaveBeenCalled();
    expect(workflows.appendResult).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ index: 0, status: 'SUCCEEDED', detail: 'sent' }),
    );
    expect(res).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('NEVER calls execute when the claim is lost — the double-send this fix prevents', async () => {
    const { processor, workflows, executor } = build(false);
    const res = await processor.process(actionJob());
    expect(workflows.claimAction).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(workflows.appendResult).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: 'already-claimed' });
  });

  it('claims BEFORE evaluating conditions, so a SKIPPED outcome still owns the claim (no re-evaluation race)', async () => {
    const { processor, workflows } = build(true);
    workflows.evaluateConditions.mockReturnValue(false);
    const res = await processor.process(actionJob());
    expect(workflows.claimAction).toHaveBeenCalled();
    expect(workflows.appendResult).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'SKIPPED' }));
    expect(res).toMatchObject({ skipped: true });
  });

  it('throws (for BullMQ retry) when the executed outcome is FAILED, even though the claim succeeded', async () => {
    const { processor, executor } = build(true);
    executor.execute.mockResolvedValue({ status: 'FAILED', detail: 'timeout' });
    await expect(processor.process(actionJob())).rejects.toThrow(/failed/);
  });
});
