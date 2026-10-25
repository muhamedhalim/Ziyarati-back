import type { TenantContextService } from '../../core/tenant-context/tenant-context.service';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { WhatsappBotActorService } from './whatsapp-bot-actor.service';

/**
 * Runs `fn` as the clinic's own least-privilege `ai-bot` principal, inside a
 * fresh tenant context for that clinic.
 *
 * Every automated booking path (the public booking flow, the AI booking tool,
 * a waitlist offer acceptance) acts on a patient's behalf with no staff user of
 * its own. They all need the same three steps: resolve the clinic's bot, open a
 * nested tenant context, and set the bot as that context's principal so
 * `AppointmentsService` scopes and authorises against the bot's permissions —
 * never the visitor's, never another tenant's. Doing it in one place keeps that
 * privilege boundary from drifting between callers.
 */
export async function runAsBotActor<T>(
  botActor: Pick<WhatsappBotActorService, 'ensureBotActor'>,
  tenantContext: Pick<TenantContextService, 'run' | 'setPrincipal'>,
  tenantId: string,
  fn: (bot: AuthenticatedUser) => Promise<T>,
): Promise<T> {
  const bot = await botActor.ensureBotActor(tenantId);
  return tenantContext.run(async () => {
    tenantContext.setPrincipal(bot);
    return fn(bot);
  });
}
