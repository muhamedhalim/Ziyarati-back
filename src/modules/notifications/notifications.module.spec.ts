import * as fs from 'node:fs';
import * as path from 'node:path';

import { ConfigService } from '@nestjs/config';

import { NotificationChannelFactory } from './channels/notification-channel.factory';
import { MetaWhatsAppCloudProvider } from './channels/meta-whatsapp-cloud.provider';
import { EmailChannelProvider } from './channels/email-channel.provider';
import { EmailProviderFactory } from '../email/providers/email-provider.factory';
import { NOTIFICATION_CHANNEL } from './notification.constants';

describe('NotificationsModule — channel registration (T012/T013)', () => {
  it('never registers NoopChannelProvider — a fake success would shadow a real provider (FR-G013)', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'notifications.module.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*import.*NoopChannelProvider/m);
    expect(source).not.toMatch(/^\s*NoopChannelProvider\s*,?\s*$/m);
  });

  it('the factory resolves WHATSAPP to the real Meta provider', () => {
    const config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService;
    const whatsapp = new MetaWhatsAppCloudProvider(config);
    const emailProviderFactory = {
      isLiveDelivery: jest.fn(() => false),
      resolve: jest.fn(),
    } as unknown as EmailProviderFactory;
    const email = new EmailChannelProvider(emailProviderFactory);

    const factory = new NotificationChannelFactory([whatsapp, email]);
    expect(factory.resolve(NOTIFICATION_CHANNEL.WHATSAPP)).toBe(whatsapp);
    expect(factory.resolve(NOTIFICATION_CHANNEL.EMAIL)).toBe(email);
  });

  it('throws (never falls back to a fake success) for an unregistered channel', () => {
    const config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as unknown as ConfigService;
    const whatsapp = new MetaWhatsAppCloudProvider(config);
    const factory = new NotificationChannelFactory([whatsapp]);
    expect(() => factory.resolve('PUSH')).toThrow();
  });
});
