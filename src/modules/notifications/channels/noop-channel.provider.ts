import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryResult,
  NotificationChannelProvider,
  NotificationPayload,
} from './notification-channel.interface';

/**
 * Default no-op channel provider.
 *
 * Acts as the universal fallback so the dispatch flow is runnable end-to-end
 * without any real integration: it "delivers" successfully and returns a stub
 * reference. Replace/augment by registering real providers into
 * NOTIFICATION_CHANNELS — this stays as the safety-net fallback.
 */
@Injectable()
export class NoopChannelProvider implements NotificationChannelProvider {
  readonly name = 'noop';
  private readonly logger = new Logger('NoopChannelProvider');

  supports(): boolean {
    return true; // fallback for every channel
  }

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    this.logger.log(
      `Simulated ${payload.channel ?? 'UNKNOWN'} delivery to ` +
        `${payload.recipientType ?? '?'}:${payload.recipientId ?? '?'} (tenant ${payload.tenantId})`,
    );
    return { success: true, providerRef: 'noop' };
  }
}
