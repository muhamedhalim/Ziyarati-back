/**
 * SETTINGS_REGISTRY — single source of truth for all typed platform settings.
 *
 * Each entry defines the key, type, category, description, default value, and
 * optional validation constraints. The service validates writes against this
 * registry; the controller exposes it so the frontend can render the correct
 * control type without hard-coding field definitions.
 *
 * Keys NOT in this registry are treated as raw developer KV pairs and receive
 * no type validation (the legacy free-form path stays available).
 */

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
    type: 'string',
    category: 'ai',
    label: 'Default AI Model',
    description: 'Default AI model for new agents that do not specify a model explicitly.',
    default: 'gpt-4o',
  },
  [SettingKey.AI_DEFAULT_TEMP]: {
    key: SettingKey.AI_DEFAULT_TEMP,
    type: 'number',
    category: 'ai',
    label: 'Default Temperature',
    description: 'Default temperature for AI responses. Lower values are deterministic; higher values are creative.',
    default: 0.2,
    min: 0,
    max: 2,
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
