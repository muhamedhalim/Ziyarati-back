import * as Joi from 'joi';

export const validate = (config: Record<string, unknown>) => {
  const schema = Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),

    DATABASE_URL: Joi.string().required(),

    TYPEORM_SYNCHRONIZE: Joi.string()
      .valid('true', 'false')
      .default('false'),

    TYPEORM_LOGGING: Joi.string()
      .valid('true', 'false')
      .default('false'),

    DB_POOL_MAX: Joi.number().default(10),
    DB_POOL_MIN: Joi.number().default(1),
    DB_POOL_IDLE_TIMEOUT: Joi.number().default(30000),

    // Redis / BullMQ. REDIS_URL is required at runtime by the queue subsystem
    // (the worker won't process without it); kept optional in the schema so the
    // API can still boot in environments where queues are disabled.
    REDIS_URL: Joi.string().allow('', null),
    QUEUE_DEFAULT_ATTEMPTS: Joi.number().default(5),
    QUEUE_BACKOFF_MS: Joi.number().default(3000),
    WORKER_CONCURRENCY: Joi.number().default(5),

    JWT_ACCESS_SECRET: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),

    // ── Payments / Moyasar (PLATFORM-level only) ──────────────────────────
    // Optional: when unset, the payment gateway factory falls back to the
    // Noop provider so the app boots and runs without a live integration.
    MOYASAR_SECRET_KEY: Joi.string().allow('', null),
    MOYASAR_PUBLISHABLE_KEY: Joi.string().allow('', null),
    MOYASAR_WEBHOOK_SECRET: Joi.string().allow('', null),
    MOYASAR_API_BASE: Joi.string().allow('', null),
  });

  const { error, value } = schema.validate(config, {
    allowUnknown: true,
    abortEarly: false,
  });

  if (error) {
    throw new Error(
      `❌ Env validation error: ${error.message}`,
    );
  }

  return value;
};