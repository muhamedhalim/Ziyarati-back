import { getAppRevision } from '../utils/app-revision.util';

/**
 * Resolved, validated logging configuration for one process root.
 *
 * Every value that ends up in EVERY log line (service, env, version) is
 * validated against a short, boring pattern first: a misconfigured or hostile
 * environment variable must not be able to put arbitrary text — a secret, a URL,
 * a newline — into the base fields of the whole log stream. Anything that fails
 * validation falls back to an explicit placeholder rather than being echoed.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
export type LogFormat = 'json' | 'pretty';
export type ProcessRole = 'api' | 'worker' | 'migrate' | 'cli';

export interface LogConfig {
  service: string;
  env: string;
  version: string;
  level: LogLevel;
  format: LogFormat;
}

const LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
  'silent',
];
const SERVICE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

/**
 * `APP_ENV` (set per environment by Terraform) wins, because every deployed
 * environment — staging included — runs with `NODE_ENV=production`. Without
 * it, `NODE_ENV` is mapped onto the same small vocabulary.
 */
export function resolveLogEnv(env: NodeJS.ProcessEnv = process.env): string {
  const appEnv = (env.APP_ENV ?? '').trim().toLowerCase();
  if (ENV_RE.test(appEnv)) return appEnv;
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  switch (nodeEnv) {
    case 'production':
    case 'prod':
      return 'production';
    case 'staging':
      return 'staging';
    case 'test':
      return 'test';
    case '':
    case 'development':
    case 'dev':
      return 'development';
    default:
      return 'unknown';
  }
}

/** `APP_VERSION` (release tag) when valid, else the validated commit SHA, else `unknown`. */
export function resolveLogVersion(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const version = (env.APP_VERSION ?? '').trim();
  if (VERSION_RE.test(version)) return version;
  return getAppRevision(env);
}

/** True for every environment whose logs are shipped and searched centrally. */
export function isDeployedEnv(
  env: string,
  nodeEnv: string | undefined,
): boolean {
  return env === 'production' || env === 'staging' || nodeEnv === 'production';
}

export function resolveLogConfig(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
): LogConfig {
  const logEnv = resolveLogEnv(env);
  const deployed = isDeployedEnv(logEnv, env.NODE_ENV);

  const rawService = (env.SERVICE_NAME ?? '').trim().toLowerCase();
  const service = SERVICE_RE.test(rawService)
    ? rawService
    : `ziyaratech-${role}`;

  const rawLevel = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  const level: LogLevel = (LEVELS as readonly string[]).includes(rawLevel)
    ? (rawLevel as LogLevel)
    : deployed
      ? 'info'
      : logEnv === 'test'
        ? 'warn'
        : 'debug';

  // Deployed environments are ALWAYS JSON: a pretty line in CloudWatch is a
  // line nobody can query by field. `LOG_FORMAT=pretty` is a local nicety only.
  const rawFormat = (env.LOG_FORMAT ?? '').trim().toLowerCase();
  const format: LogFormat = deployed
    ? 'json'
    : rawFormat === 'json' || rawFormat === 'pretty'
      ? rawFormat
      : logEnv === 'development'
        ? 'pretty'
        : 'json';

  return {
    service,
    env: logEnv,
    version: resolveLogVersion(env),
    level,
    format,
  };
}
