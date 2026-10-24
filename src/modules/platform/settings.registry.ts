/**
 * SETTINGS_REGISTRY — single source of truth for all typed platform settings.
 *
 * Each entry defines the key, type, category, description, default value, and
 * optional validation constraints. The service validates writes against this
 * registry; the controller exposes it so the frontend can render the correct
 * control type without hard-coding field definitions.
 */

import {
  AI_MODEL_IDS,
  defaultModelForTier,
} from '../ai/routing/ai-model-registry';

export enum SettingKey {
  MAINTENANCE_MODE    = 'platform.maintenance_mode',
  ALLOW_REGISTRATION  = 'platform.allow_tenant_registration',
  TRIAL_DURATION_DAYS = 'billing.trial_duration_days',
  PAYMENT_LINK_TTL    = 'billing.payment_link_ttl_hours',
  DEFAULT_CURRENCY    = 'billing.default_currency',
  MAX_FILE_SIZE_MB    = 'uploads.max_file_size_mb',
  TENANT_QUOTA_GB     = 'uploads.tenant_quota_gb',
  AI_DEFAULT_MODEL    = 'ai.default_model',
  AI_DEFAULT_TEMP     = 'ai.default_temperature',
  WHATSAPP_OPT_OUT_KEYWORDS = 'whatsapp.opt_out_keywords',
}

export type SettingType = 'boolean' | 'number' | 'string' | 'enum';
export type SettingCategory = 'general' | 'billing' | 'uploads' | 'ai' | 'whatsapp';

export interface SettingDefinition {
  key: SettingKey;
  type: SettingType;
  category: SettingCategory;
  label: string;
  description: string;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  allowedValues?: readonly string[];
}

export const SETTINGS_REGISTRY: Readonly<Record<SettingKey, SettingDefinition>> = {
  [SettingKey.MAINTENANCE_MODE]: {
    key: SettingKey.MAINTENANCE_MODE,
    type: 'boolean',
    category: 'general',
    label: 'Maintenance Mode',
    description: 'When enabled, all tenant requests return 503. Super-admins bypass this gate.',
    default: false,
  },
  [SettingKey.ALLOW_REGISTRATION]: {
    key: SettingKey.ALLOW_REGISTRATION,
    type: 'boolean',
    category: 'general',
    label: 'Allow Tenant Registration',
    description: 'Allow new clinic owners to self-register. Disable to freeze sign-ups during controlled rollout.',
    default: true,
  },
  [SettingKey.TRIAL_DURATION_DAYS]: {
    key: SettingKey.TRIAL_DURATION_DAYS,
    type: 'number',
    category: 'billing',
    label: 'Trial Duration',
    description: 'Duration in days for trial subscriptions. Overrides the plan billing cycle when a subscription starts as a trial.',
    default: 14,
    min: 1,
    max: 365,
    unit: 'days',
  },
  [SettingKey.PAYMENT_LINK_TTL]: {
    key: SettingKey.PAYMENT_LINK_TTL,
    type: 'number',
    category: 'billing',
    label: 'Payment Link TTL',
    description: 'Default payment link expiry when no explicit expiry is provided at creation.',
    default: 72,
    min: 1,
    max: 720,
    unit: 'hours',
  },
  [SettingKey.DEFAULT_CURRENCY]: {
    key: SettingKey.DEFAULT_CURRENCY,
    type: 'enum',
    category: 'billing',
    label: 'Default Currency',
    description: 'Default currency for new invoices and payment links.',
    default: 'SAR',
    allowedValues: ['SAR', 'USD', 'AED', 'EGP'],
  },
  [SettingKey.MAX_FILE_SIZE_MB]: {
    key: SettingKey.MAX_FILE_SIZE_MB,
    type: 'number',
    category: 'uploads',
    label: 'Max File Size',
    description: 'Maximum allowed file size per upload across the platform.',
    default: 50,
    min: 1,
    max: 500,
    unit: 'MB',
  },
  [SettingKey.TENANT_QUOTA_GB]: {
    key: SettingKey.TENANT_QUOTA_GB,
    type: 'number',
    category: 'uploads',
    label: 'Tenant Storage Quota',
    description: 'Total storage quota allocated per tenant.',
    default: 5,
    min: 1,
    max: 1000,
    unit: 'GB',
  },
  [SettingKey.AI_DEFAULT_MODEL]: {
    key: SettingKey.AI_DEFAULT_MODEL,
    // 'enum' (not 'string') so SystemSettingService.validateValue rejects an
    // unregistered model at write time, reusing the existing enum validator
    // rather than adding a bespoke check. Was free text, which let a super admin
    // set a model no provider supports and no price catalog can price.
    //
    // `allowedValues` is `AI_MODEL_IDS` — the registry's GA set — so restricting
    // the registry restricts this dropdown, this validator and the agent DTO in
    // one edit. The value never appears in this file, and the frontend never
    // holds a model list of its own: `/platform/system-settings` renders exactly
    // what `GET /platform/settings/typed` returns.
    type: 'enum',
    category: 'ai',
    label: 'Default AI Model',
    // Widened wording, matching what the setting now actually governs. It is
    // still the seed for a new agent's `model`, but it is ALSO handed to
    // `AiModelRouterService` on every turn as the default an agent without a
    // pinned model runs on — which is what makes this page the platform's
    // central model configuration rather than a value applied once at creation.
    description:
      'The AI model used by any agent that has no model of its own — including the public booking widget, which has no agent row. Agents pinned to a specific model are not affected.',
    // Tier-preserving migration of the previous 'gpt-4o': that model was the
    // registry's POWERFUL entry, and GPT-5.6 Terra is the POWERFUL entry of the
    // permitted set. Picking the cheaper Luna here would have been a silent
    // capability downgrade for every clinic; a super admin can still switch to
    // it in one click on this page.
    default: defaultModelForTier('POWERFUL'),
    allowedValues: AI_MODEL_IDS,
  },
  [SettingKey.AI_DEFAULT_TEMP]: {
    key: SettingKey.AI_DEFAULT_TEMP,
    type: 'number',
    category: 'ai',
    label: 'Default AI Temperature',
    // Frontend renders the 0.0–1.0 range as four named bands (see
    // AiTemperatureSettingRow); this text is also what the generic
    // NumericSettingRow/RawKvEditor show for any surface not aware of them.
    description:
      'Controls the variety of AI responses — lower values are more consistent, higher values are more creative. Applied to any agent that has no temperature of its own.',
    default: 0.2,
    min: 0,
    max: 1,
    step: 0.1,
  },
  [SettingKey.WHATSAPP_OPT_OUT_KEYWORDS]: {
    key: SettingKey.WHATSAPP_OPT_OUT_KEYWORDS,
    type: 'string',
    category: 'whatsapp',
    label: 'WhatsApp Opt-Out Keywords',
    description:
      'Comma-separated inbound keywords (any language/case) that mark a customer as opted out of WhatsApp messaging (FND-024). Matched on the whole message after trimming and case-folding — extend here, no deploy needed.',
    default: 'stop,unsubscribe,cancel,opt out,optout,إلغاء,إيقاف,توقف,الغاء الاشتراك',
  },
};

export const KNOWN_SETTING_KEYS = new Set<string>(Object.values(SettingKey));
