import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { FeatureCatalogService } from './feature-catalog.service';
import { UpsertFeatureDefinitionDto } from './dto/feature-catalog.dto';

/**
 * Seeds a starter feature catalog on boot (idempotent — only when empty). This
 * is initial DATA, not hardcoded logic: super-admins add/edit features via the
 * API afterwards, so the catalog is unbounded.
 */
const STARTER_CATALOG: UpsertFeatureDefinitionDto[] = [
  { featureKey: 'appointments', name: 'Appointments', category: 'Core', defaultEnabled: true, description: 'Booking & calendar.' },
  { featureKey: 'crm', name: 'CRM', category: 'Core', defaultEnabled: true, description: 'Customer records, tags, notes.' },
  { featureKey: 'analytics', name: 'Analytics', category: 'Core', defaultEnabled: true, description: 'Dashboards & reports.' },
  { featureKey: 'reviews', name: 'Reviews', category: 'Growth', defaultEnabled: false, description: 'Customer reviews & ratings.' },
  { featureKey: 'campaigns', name: 'Campaigns', category: 'Growth', defaultEnabled: false, description: 'Marketing campaigns.' },
  { featureKey: 'whatsapp', name: 'WhatsApp', category: 'Communication', defaultEnabled: false, description: 'WhatsApp messaging.' },
  { featureKey: 'whatsapp.campaigns', name: 'WhatsApp Campaigns', category: 'Communication', defaultEnabled: false, description: 'Bulk WhatsApp campaigns.' },
  { featureKey: 'notifications', name: 'Notifications', category: 'Communication', defaultEnabled: true, description: 'Automated notifications.' },
  { featureKey: 'ai.assistant', name: 'AI Assistant', category: 'AI', defaultEnabled: false, description: 'AI chat + booking assistant.' },
  { featureKey: 'payments', name: 'Payments', category: 'Payments', defaultEnabled: false, description: 'Online payments & settlements.' },
];

@Injectable()
export class FeatureCatalogBootstrap implements OnModuleInit {
  private readonly logger = new Logger(FeatureCatalogBootstrap.name);

  constructor(private readonly catalog: FeatureCatalogService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.catalog.seedDefaults(STARTER_CATALOG);
    } catch (err) {
      this.logger.warn(`Feature catalog seed skipped: ${(err as Error)?.message}`);
    }
  }
}
