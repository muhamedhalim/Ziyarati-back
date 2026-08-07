import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../../entities/Auth&RBAC/User';
import { AuthModule } from '../auth/auth.module';
import { WhatsappBotActorService } from '../whatsapp/whatsapp-bot-actor.service';

/**
 * The per-tenant, least-privilege `ai-bot` principal that AI-initiated writes
 * execute as.
 *
 * It was defined inside `WhatsappModule` and not exported, because WhatsApp was
 * the only channel that could book. The public web flow needs the identical
 * actor, but `AiModule` cannot import `WhatsappModule` — that would close a
 * cycle (`WhatsappModule → AiOrchestratorModule → AiModule`). Registering it
 * here, with only `AuthModule` behind it, makes it available to both channels
 * from one instance.
 *
 * The service itself is untouched and still lives in `whatsapp/`; only its
 * registration moved, so nothing about the existing WhatsApp behaviour changes.
 *
 * Why an `ai-bot` user rather than granting the guest permissions: the actor
 * carries exactly `AI_BOT_PERMISSIONS` (create/read/reschedule/cancel
 * appointments, read availability, read/create customers) inside ONE clinic,
 * and it is the `booked_by` on the resulting appointment — so the audit trail
 * says which clinic's bot made the booking. The anonymous visitor keeps zero
 * roles and zero permissions throughout.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User]), AuthModule],
  providers: [WhatsappBotActorService],
  exports: [WhatsappBotActorService],
})
export class AiBotActorModule {}
