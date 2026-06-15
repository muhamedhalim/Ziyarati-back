import { Injectable } from '@nestjs/common';

import {
  ResolvedWhatsappAccount,
  WhatsappAccountResolver,
} from './whatsapp-account.resolver';

export interface WhatsappRouteRequest {
  /** Explicit account selection — takes precedence over branch routing. */
  accountId?: string;
  /** Branch context for hybrid CUSTOM→PLATFORM routing. */
  branchId?: string;
}

/**
 * Single entry point the messaging/execution layer uses to pick a sending
 * identity. Encapsulates the routing policy so service code never branches on
 * mode/credentials itself:
 *
 *   explicit accountId  → that account
 *   else branch given   → branch CUSTOM, else branch PLATFORM
 *   else                → env PLATFORM (shared SaaS number)
 *
 * Swapping the policy (e.g. round-robin across multiple numbers in future) is a
 * change here only.
 */
@Injectable()
export class WhatsappMessageRouter {
  constructor(private readonly resolver: WhatsappAccountResolver) {}

  resolveForSend(
    tenantId: string,
    req: WhatsappRouteRequest = {},
  ): Promise<ResolvedWhatsappAccount> {
    if (req.accountId) {
      return this.resolver.byId(tenantId, req.accountId);
    }
    return this.resolver.forBranch(tenantId, req.branchId);
  }
}
