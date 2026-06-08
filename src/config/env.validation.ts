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

    REDIS_URL: Joi.string().allow('', null),

    JWT_ACCESS_SECRET: Joi.string().required(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),
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