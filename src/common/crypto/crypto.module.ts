import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { EncryptionService } from './encryption.service';

/**
 * Credential encryption primitives.
 *
 * Global because encrypt-at-rest is a cross-cutting concern: any module holding
 * a third-party secret (WhatsApp/Meta today, other providers later) needs it,
 * and re-importing a crypto module everywhere invites someone to skip it.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class CryptoModule {}
