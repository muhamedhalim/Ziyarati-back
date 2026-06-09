import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_CHANNELS,
  NotificationChannelProvider,
} from './notification-channel.interface';
import { NoopChannelProvider } from './noop-channel.provider';

/**
 * Factory that resolves the delivery provider for a channel (strategy
 * selection). Real providers are injected via the NOTIFICATION_CHANNELS token;
 * if none supports the requested channel, the no-op provider is used. This is
 * the single seam through which the dispatcher reaches a provider, keeping
 * delivery loosely coupled and trivially extensible.
 */
@Injectable()
export class NotificationChannelFactory {
  constructor(
    @Inject(NOTIFICATION_CHANNELS)
    private readonly providers: NotificationChannelProvider[],
    private readonly fallback: NoopChannelProvider,
  ) {}

  resolve(channel?: string): NotificationChannelProvider {
    return (
      this.providers.find((p) => p.supports(channel)) ?? this.fallback
    );
  }
}
