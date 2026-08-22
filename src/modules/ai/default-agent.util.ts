import { IsNull, Repository } from 'typeorm';

import { AiAgent } from '../../entities/AI Agent/AiAgent';

/**
 * Resolves the agent that clinic-owner-initiated knowledge/training content
 * binds to when no `agentId` is supplied. Agents and models are platform-
 * (Admin-)managed — the clinic owner never sees or picks one — so this
 * mirrors `AgentRouterService`'s own fallback (backend
 * `modules/ai-orchestrator/agent-router.service.ts`): the tenant's role-less
 * active agent, the same "legacy single-agent default" chat routing already
 * falls back to, or else its oldest active agent. Returns `null` only if the
 * tenant has no active agent at all (nothing for the Admin to have
 * provisioned yet).
 */
export async function resolveDefaultAgentId(
  agents: Repository<AiAgent>,
  tenantId: string,
): Promise<string | null> {
  const fallback = await agents.findOne({
    where: [
      { tenant: { id: tenantId }, role: IsNull(), is_active: true },
      { tenant: { id: tenantId }, is_active: true },
    ],
    order: { created_at: 'ASC' },
  });
  return fallback?.id ?? null;
}
