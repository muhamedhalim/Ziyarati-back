import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CHANNELS,
  NotificationChannelProvider,
} from './notification-channel.interface';
import { AppError, ErrorCode } from '../../../common/errors';

/**
 * Resolves the delivery provider for a channel (strategy selection).
 *
 * STRICT resolution: if NO registered provider supports the channel, this THROWS
 * — it never silently falls back to a no-op "success". A missing/misconfigured
 * channel must surface as a hard failure, not a fake delivery.
 */
@Injectable()
export class NotificationChannelFactory {
  constructor(
    @Inject(NOTIFICATION_CHANNELS)
    private readonly providers: NotificationChannelProvider[],
  ) {}

  resolve(channel?: string): NotificationChannelProvider {
    const provider = this.providers.find((p) => p.supports(channel));
    if (!provider) {
      throw new AppError(ErrorCode.UNPROCESSABLE_ENTITY, {
        message: `No notification provider registered for channel "${channel ?? 'UNKNOWN'}"`,
        publicContext: { channel },
      });
    }
    return provider;
  }
}
