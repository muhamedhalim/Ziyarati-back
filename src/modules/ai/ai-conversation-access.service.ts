import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AiConversation } from '../../entities/AI Agent/AiConversation';
import { AppError, ErrorCode } from '../../common/errors';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * The single authorization seam for "may this principal touch this AI
 * conversation?".
 *
 * Tenant scoping alone is NOT an ownership boundary for anonymous visitors:
 * every guest principal is minted into the SAME synthetic discovery tenant
 * (`GuestSessionService.DISCOVERY_TENANT_SLUG`), so `tenant = { id: tenantId }`
 * puts all of them in one bucket. Guest ownership therefore additionally
 * requires the FND-001 binding — `session.guestSubject` must equal the guest
 * token's `sub` — which until now was enforced only by
 * `GuestSessionService.convert()`, leaving every resume / join / typing / seen /
 * handover path open to any guest holding another guest's conversation id.
 *
 * Fail-closed contract (mirrors `AiSession.guestSubject`'s own docblock): a
 * guest conversation with NO binding is NOT accessible — absence never means
 * "unowned, therefore allowed".
 *
 * Every rejection raises the SAME `NOT_FOUND` an unknown id raises, so this is
 * not an existence oracle.
 */
@Injectable()
export class AiConversationAccessService {
  constructor(
    @InjectRepository(AiConversation)
    private readonly conversations: Repository<AiConversation>,
  ) {}

  /**
   * Loads the conversation only if `principal` may act on it, with the same
   * relations `AiConversationService.findOne` returns so callers can use it as a
   * drop-in replacement.
   *
   * `principal` is the SERVER-verified acting user (WS: `client.data.user`, set
   * by `WsAuthService` after signature verification; REST/worker:
   * `TenantContextService.getUser()`). It is never client-asserted.
   */
  async assertAccess(
    tenantId: string,
    aiConversationId: string,
    principal: AuthenticatedUser | null | undefined,
  ): Promise<AiConversation> {
    if (!tenantId || !aiConversationId) throw this.notFound();

    const conv = await this.conversations.findOne({
      where: { id: aiConversationId, tenant: { id: tenantId } },
      relations: { agent: true, conversation: true },
    });
    if (!conv) throw this.notFound();

    if (principal?.guest) {
      const boundSubject = (conv.session as { guestSubject?: string } | null)
        ?.guestSubject;
      if (!boundSubject || boundSubject !== principal.id) throw this.notFound();
    }

    return conv;
  }

  /** Boolean form for socket handlers that must not throw across the wire. */
  async canAccess(
    tenantId: string,
    aiConversationId: string,
    principal: AuthenticatedUser | null | undefined,
  ): Promise<boolean> {
    try {
      await this.assertAccess(tenantId, aiConversationId, principal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One uniform rejection for "does not exist" and "not yours" alike — the same
   * anti-enumeration posture as `GuestSessionService.notFound()`.
   */
  private notFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, {
      message: 'AI conversation not found',
    });
  }
}
