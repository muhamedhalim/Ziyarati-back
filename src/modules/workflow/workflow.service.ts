import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { Workflow, WorkflowConditionSpec } from '../../entities/Workflows/Workflow';
import { WorkflowRun, WorkflowActionResult } from '../../entities/Workflows/WorkflowRun';
import { Tenant } from '../../entities/SaaS-Core/Tenant';
import { AppError, ErrorCode } from '../../common/errors';

import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { WorkflowFilterDto } from './dto/workflow-filter.dto';
import { WORKFLOW_OPERATOR, WORKFLOW_RUN_STATUS } from './workflow.constants';

/**
 * Tenant-scoped CRUD for workflows + the run lifecycle (create / evaluate
 * conditions / record outcomes). Holds NO action logic — execution lives in the
 * WorkflowActionExecutor, which delegates to the existing domain services.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @InjectRepository(Workflow) private readonly workflows: Repository<Workflow>,
    @InjectRepository(WorkflowRun) private readonly runs: Repository<WorkflowRun>,
  ) {}

  // ─────────────────────────────── CRUD ──────────────────────────────────── //

  async create(tenantId: string, dto: CreateWorkflowDto): Promise<Workflow> {
    const row = this.workflows.create({
      tenant: { id: tenantId } as Tenant,
      name: dto.name,
      description: dto.description,
      trigger_event: dto.triggerEvent,
      is_active: dto.isActive ?? true,
      conditions: dto.conditions,
      actions: dto.actions,
    });
    return this.workflows.save(row);
  }

  async findAll(tenantId: string, filter: WorkflowFilterDto) {
    const where: FindOptionsWhere<Workflow> = { tenant: { id: tenantId } };
    if (filter.triggerEvent) where.trigger_event = filter.triggerEvent;
    if (filter.isActive !== undefined) where.is_active = filter.isActive === 'true';
    if (filter.q) where.name = ILike(`%${filter.q}%`);

    const [data, total] = await this.workflows.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return { data, total, page: filter.page, limit: filter.limit };
  }

  /** Copies a workflow (name suffixed, starts INACTIVE so it can be reviewed first). */
  async duplicate(tenantId: string, id: string): Promise<Workflow> {
    const source = await this.findOne(tenantId, id);
    const copy = this.workflows.create({
      tenant: { id: tenantId } as Tenant,
      name: `${source.name} (copy)`,
      description: source.description,
      trigger_event: source.trigger_event,
      is_active: false,
      conditions: source.conditions,
      actions: source.actions,
    });
    return this.workflows.save(copy);
  }

  async findOne(tenantId: string, id: string): Promise<Workflow> {
    const row = await this.workflows.findOne({ where: { id, tenant: { id: tenantId } } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Workflow not found' });
    return row;
  }

  async update(tenantId: string, id: string, dto: UpdateWorkflowDto): Promise<Workflow> {
    const row = await this.findOne(tenantId, id);
    if (dto.name !== undefined) row.name = dto.name;
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.triggerEvent !== undefined) row.trigger_event = dto.triggerEvent;
    if (dto.isActive !== undefined) row.is_active = dto.isActive;
    if (dto.conditions !== undefined) row.conditions = dto.conditions;
    if (dto.actions !== undefined) row.actions = dto.actions;
    return this.workflows.save(row);
  }

  async remove(tenantId: string, id: string): Promise<{ id: string; deleted: true }> {
    const row = await this.findOne(tenantId, id);
    await this.workflows.remove(row);
    return { id, deleted: true };
  }

  // ─────────────────────────── Engine helpers ────────────────────────────── //

  /** Active workflows for a tenant + trigger — consumed by the event listener. */
  findActiveByTrigger(tenantId: string, trigger: string): Promise<Workflow[]> {
    return this.workflows.find({
      where: { tenant: { id: tenantId }, trigger_event: trigger, is_active: true },
      order: { created_at: 'ASC' },
    });
  }

  /** Load a workflow by id WITHOUT tenant scoping (worker already trusts the run). */
  findByIdInternal(id: string): Promise<Workflow | null> {
    return this.workflows.findOne({ where: { id } });
  }

  createRun(
    tenantId: string,
    workflow: Workflow,
    context: Record<string, unknown>,
  ): Promise<WorkflowRun> {
    return this.runs.save(
      this.runs.create({
        tenant: { id: tenantId } as Tenant,
        workflow: { id: workflow.id } as Workflow,
        trigger_event: workflow.trigger_event,
        status: WORKFLOW_RUN_STATUS.PENDING,
        context,
        results: [],
      }),
    );
  }

  async getRunWithWorkflow(runId: string): Promise<{ run: WorkflowRun; workflow: Workflow } | null> {
    const run = await this.runs.findOne({ where: { id: runId }, relations: { workflow: true } });
    if (!run || !run.workflow) return null;
    // relations gives a shallow workflow; reload to guarantee jsonb columns present.
    const workflow = await this.findByIdInternal(run.workflow.id);
    if (!workflow) return null;
    return { run, workflow };
  }

  async markRunning(runId: string): Promise<void> {
    await this.runs.update({ id: runId }, { status: WORKFLOW_RUN_STATUS.RUNNING });
  }

  /**
   * Record one action outcome (audit) — idempotent per action index, so a
   * retried action REPLACES its prior result rather than appending a duplicate.
   */
  async appendResult(runId: string, result: WorkflowActionResult): Promise<void> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) return;
    const others = (run.results ?? []).filter((r) => r.index !== result.index);
    run.results = [...others, result].sort((a, b) => a.index - b.index);
    await this.runs.save(run);
  }

  /** Finalize once every DISTINCT action index has a terminal result. */
  async finalizeRun(runId: string, totalActions: number): Promise<void> {
    const run = await this.runs.findOne({ where: { id: runId } });
    if (!run) return;
    const results = run.results ?? [];
    const distinct = new Set(results.map((r) => r.index));
    if (distinct.size < totalActions) return; // not all actions reported yet
    const anyFailed = results.some((r) => r.status === 'FAILED');
    run.status = anyFailed ? WORKFLOW_RUN_STATUS.FAILED : WORKFLOW_RUN_STATUS.COMPLETED;
    run.completed_at = new Date();
    await this.runs.save(run);
  }

  async listRuns(tenantId: string, workflowId: string, page = 1, limit = 20) {
    await this.findOne(tenantId, workflowId); // tenant ownership check
    const [data, total] = await this.runs.findAndCount({
      where: { tenant: { id: tenantId }, workflow: { id: workflowId } },
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  /** Tenant-scoped single run fetch (ownership enforced via the run's own tenant relation). */
  async getOwnedRun(tenantId: string, runId: string): Promise<WorkflowRun> {
    const run = await this.runs.findOne({ where: { id: runId, tenant: { id: tenantId } } });
    if (!run) throw new AppError(ErrorCode.NOT_FOUND, { message: 'Workflow run not found' });
    return run;
  }

  /** The action indices whose last recorded outcome was FAILED (candidates for retry). */
  failedActionIndices(run: WorkflowRun): number[] {
    return (run.results ?? []).filter((r) => r.status === 'FAILED').map((r) => r.index);
  }

  /** Reopens a run for retry (RUNNING) — the caller re-enqueues the failed action indices. */
  async reopenForRetry(runId: string): Promise<void> {
    await this.runs.update({ id: runId }, { status: WORKFLOW_RUN_STATUS.RUNNING, completed_at: undefined });
  }

  /**
   * Evaluate ALL conditions against the run context (AND). No conditions = pass.
   * Pure + side-effect-free so it is trivially testable.
   */
  evaluateConditions(conditions: WorkflowConditionSpec[] | undefined, context: Record<string, unknown>): boolean {
    if (!conditions || conditions.length === 0) return true;
    return conditions.every((c) => this.matchOne(c, context));
  }

  private matchOne(cond: WorkflowConditionSpec, context: Record<string, unknown>): boolean {
    const actual = context?.[cond.field];
    const expected = cond.value;
    switch (cond.operator) {
      case WORKFLOW_OPERATOR.EQ:
        return actual === expected;
      case WORKFLOW_OPERATOR.NEQ:
        return actual !== expected;
      case WORKFLOW_OPERATOR.GT:
        return this.num(actual) > this.num(expected);
      case WORKFLOW_OPERATOR.GTE:
        return this.num(actual) >= this.num(expected);
      case WORKFLOW_OPERATOR.LT:
        return this.num(actual) < this.num(expected);
      case WORKFLOW_OPERATOR.LTE:
        return this.num(actual) <= this.num(expected);
      case WORKFLOW_OPERATOR.IN:
        return Array.isArray(expected) && expected.includes(actual);
      case WORKFLOW_OPERATOR.CONTAINS:
        return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected);
      case WORKFLOW_OPERATOR.EXISTS:
        return actual !== undefined && actual !== null;
      default:
        return false;
    }
  }

  private num(v: unknown): number {
    const x = Number(v);
    return Number.isFinite(x) ? x : NaN;
  }
}
