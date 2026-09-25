import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { WhatsappAccount } from '../../../entities/WhatsApp/WhatsappAccount';
import { EncryptionService } from '../../../common/crypto/encryption.service';

import { MetaGraphClient } from './meta-graph.client';
import {
  COEXISTENCE_SYNC_STATUS,
  WHATSAPP_ONBOARDING_TYPE,
} from '../whatsapp.constants';

export interface CoexistenceSyncResult {
  ran: boolean;
  reason?: string;
}

/**
 * Runs the two required Coexistence sync operations for one account, in
 * Meta's documented order: `smb_app_state_sync` first, `history` second
 * (`POST /{phone_number_id}/smb_app_data`).
 *
 * IDEMPOTENCY is the entire point of this class. Each step is gated on the
 * account's OWN persisted status, re-read fresh on every call:
 *  - a step already `COMPLETED` is never re-triggered (Meta's docs are
 *    explicit that a sync must not be re-run without re-onboarding);
 *  - a step already `IN_PROGRESS` is left alone — the outbound POST already
 *    succeeded and the platform is waiting on Meta's confirming webhook
 *    (`WhatsappWebhookService.processEvent`, which is what actually flips a
 *    step to COMPLETED — this service never marks COMPLETED itself, only
 *    IN_PROGRESS/FAILED, since a 200 from the trigger call is not the same
 *    fact as "the sync finished").
 * Combined with `QueueService.enqueueWhatsappCoexistenceSync`'s deterministic
 * per-account jobId, a redelivered job, a duplicate onboarding retry, and an
 * admin-triggered re-run all converge on the same safe outcome: run whatever
 * hasn't run yet, touch nothing that has.
 *
 * A failure in EITHER step is recorded (`coexistence_last_sync_error`,
 * status FAILED) and rethrown so BullMQ retries with backoff — it never
 * throws out of `complete()` in MetaEmbeddedSignupService (this runs on the
 * queue, after onboarding has already returned to the caller), so a sync
 * failure can never break onboarding itself.
 */
@Injectable()
export class WhatsappCoexistenceSyncService {
  private readonly logger = new Logger('WhatsappCoexistenceSyncService');

  constructor(
    @InjectRepository(WhatsappAccount)
    private readonly accounts: Repository<WhatsappAccount>,
    private readonly graph: MetaGraphClient,
    private readonly encryption: EncryptionService,
  ) {}

  async run(
    tenantId: string,
    accountId: string,
  ): Promise<CoexistenceSyncResult> {
    const account = await this.accounts.findOne({
      where: { id: accountId, tenant: { id: tenantId }, deleted_at: IsNull() },
    });
    if (!account) return { ran: false, reason: 'account-not-found' };
    if (account.onboarding_type !== WHATSAPP_ONBOARDING_TYPE.COEXISTENCE) {
      return { ran: false, reason: 'not-coexistence' };
    }
    if (!account.phone_number_id || !account.access_token) {
      return { ran: false, reason: 'account-not-connected' };
    }

    const token = this.encryption.decrypt(account.access_token);

    await this.runStep(
      account,
      'coexistence_state_sync_status',
      'coexistence_state_sync_at',
      'smb_app_state_sync',
      token,
    );

    // History is sequenced AFTER state sync per Meta's documented order.
    // Re-read is unnecessary here (runStep above already updated the row on
    // success); the in-memory snapshot from the top of this method is still
    // correct for this decision because nothing else in this process can
    // have changed it between the two calls.
    await this.runStep(
      account,
      'coexistence_history_sync_status',
      'coexistence_history_sync_at',
      'history',
      token,
    );

    return { ran: true };
  }

  private async runStep(
    account: WhatsappAccount,
    statusField:
      | 'coexistence_state_sync_status'
      | 'coexistence_history_sync_status',
    atField: 'coexistence_state_sync_at' | 'coexistence_history_sync_at',
    syncType: 'smb_app_state_sync' | 'history',
    token: string,
  ): Promise<void> {
    const status = account[statusField];
    if (
      status === COEXISTENCE_SYNC_STATUS.COMPLETED ||
      status === COEXISTENCE_SYNC_STATUS.IN_PROGRESS
    ) {
      this.logger.log(
        `COEXISTENCE_SYNC_SKIPPED account=${account.id} step=${syncType} status=${status} — already triggered/completed`,
      );
      return;
    }

    await this.accounts.update(account.id, {
      [statusField]: COEXISTENCE_SYNC_STATUS.IN_PROGRESS,
    });
    this.logger.log(
      `COEXISTENCE_SYNC_STARTED account=${account.id} step=${syncType}`,
    );

    try {
      await this.graph.triggerSmbAppDataSync(
        account.phone_number_id!,
        token,
        syncType,
      );
      await this.accounts.update(account.id, {
        [atField]: new Date(),
        coexistence_last_sync_error: null,
      });
      // Deliberately NOT set to COMPLETED here — see class docblock. Status
      // stays IN_PROGRESS until the corresponding inbound webhook confirms.
      account[statusField] = COEXISTENCE_SYNC_STATUS.IN_PROGRESS;
      this.logger.log(
        `COEXISTENCE_SYNC_ACCEPTED account=${account.id} step=${syncType} — awaiting Meta confirmation webhook`,
      );
    } catch (err) {
      const message = (err as Error)?.message ?? 'unknown error';
      await this.accounts.update(account.id, {
        [statusField]: COEXISTENCE_SYNC_STATUS.FAILED,
        coexistence_last_sync_error: message,
      });
      this.logger.error(
        `COEXISTENCE_SYNC_FAILED account=${account.id} step=${syncType}: ${message}`,
      );
      throw err;
    }
  }
}
