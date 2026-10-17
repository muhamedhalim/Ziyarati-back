import { Logger } from '@nestjs/common';
import diagnosticsChannel from 'node:diagnostics_channel';

import { LOG_EVENT } from './log-events';

/**
 * Outcome + latency of every outbound HTTP call made with Node's built-in
 * `fetch` (undici) — which is how the Meta Graph / WhatsApp clients, the Tap
 * client, the OpenAI SDK and the AWS SDK clients all talk to their APIs.
 *
 * Subscribes to undici's public `diagnostics_channel` events, so no client
 * code changes and there is exactly one implementation. It never reads
 * request/response bodies or headers; it reads the origin, the method, the
 * status and the PATH ONLY (the query string is dropped before anything else:
 * Meta Graph calls carry `access_token` there). Ids in the path are collapsed
 * to `:id`, so `operation` is a low-cardinality template.
 *
 * Not covered: the AWS SDK (S3/SES/SQS uses `node:http`, not undici).
 *
 * Levels: failures that point at the provider or the network (5xx, 429,
 * timeouts, connection errors) are `warn`; 4xx and successes are `debug` —
 * the calling code owns the business meaning of a rejected request and
 * already reports it. Metrics are recorded for every call.
 */
export type ProviderOutcome =
  | 'success'
  | 'client_error'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network_error';

export interface ProviderMetricsSink {
  observeProviderRequest(
    provider: string,
    outcome: ProviderOutcome,
    durationSeconds: number,
  ): void;
}

/** Host → stable provider label. Anything else is `other` (tenant webhook targets included). */
const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)graph\.facebook\.com$/i, 'meta_graph'],
  [/(^|\.)api\.tap\.company$/i, 'tap'],
  [/(^|\.)api\.openai\.com$/i, 'openai'],
  [/(^|\.)openai\.azure\.com$/i, 'azure_openai'],
  [/(^|\.)api\.anthropic\.com$/i, 'anthropic'],
  [/(^|\.)api\.moyasar\.com$/i, 'moyasar'],
];

const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
]);

interface UndiciRequest {
  origin?: string | URL;
  method?: string;
  path?: string;
}

const logger = new Logger('ProviderClient');
const inflight = new WeakMap<
  object,
  { start: bigint; provider: string; method: string; operation: string }
>();
let metricsSink: ProviderMetricsSink | undefined;
let installed = false;

export function setProviderMetricsSink(
  sink: ProviderMetricsSink | undefined,
): void {
  metricsSink = sink;
}

export function providerForOrigin(origin: string | URL | undefined): string {
  if (!origin) return 'other';
  let host: string;
  try {
    host = (origin instanceof URL ? origin : new URL(String(origin))).hostname;
  } catch {
    return 'other';
  }
  for (const [re, name] of PROVIDERS) if (re.test(host)) return name;
  return 'other';
}

/** `/v21.0/1234567890/messages?access_token=…` → `/v21.0/:id/messages`. */
export function operationTemplate(path: string | undefined): string {
  if (!path) return '/';
  const pathOnly = path.split('?')[0].split('#')[0];
  const segments = pathOnly.split('/').map((s) => {
    if (s === '') return s;
    if (/^v\d+(\.\d+)?$/i.test(s)) return s; // API version
    if (/\d/.test(s) || s.length > 32) return ':id';
    return /^[A-Za-z_-]{1,32}$/.test(s) ? s : ':id';
  });
  return segments.join('/').slice(0, 120) || '/';
}

export function classifyStatus(status: number): ProviderOutcome {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

export function classifyError(err: unknown): ProviderOutcome {
  const e = err as {
    code?: string;
    name?: string;
    cause?: { code?: string };
  } | null;
  const code = e?.code ?? e?.cause?.code;
  if (
    (code && TIMEOUT_CODES.has(code)) ||
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError'
  ) {
    return 'timeout';
  }
  return 'network_error';
}

function finish(
  request: object,
  outcome: ProviderOutcome,
  status?: number,
  errorCode?: string,
): void {
  const entry = inflight.get(request);
  if (!entry) return;
  inflight.delete(request);
  const seconds = Number(process.hrtime.bigint() - entry.start) / 1e9;
  metricsSink?.observeProviderRequest(entry.provider, outcome, seconds);

  const fields: Record<string, unknown> = {
    provider: entry.provider,
    method: entry.method,
    outcome,
    duration_ms: Math.round(seconds * 1000),
  };
  // Tenant-configured targets: no path at all (it is the tenant's URL).
  if (entry.provider !== 'other') fields.operation = entry.operation;
  if (status !== undefined) fields.status = status;
  if (errorCode) fields.error_code = errorCode;

  const failed = outcome !== 'success' && outcome !== 'client_error';
  if (failed) {
    logger.warn({
      ...fields,
      event: LOG_EVENT.PROVIDER_REQUEST_FAILED,
      message:
        `${entry.provider} ${entry.method} ${fields.operation ?? ''} -> ${status ?? outcome}`.replace(
          /\s+/g,
          ' ',
        ),
    });
  } else {
    logger.debug({
      ...fields,
      event:
        outcome === 'success'
          ? LOG_EVENT.PROVIDER_REQUEST_COMPLETED
          : LOG_EVENT.PROVIDER_REQUEST_FAILED,
      message: `${entry.provider} ${entry.method} -> ${status}`,
    });
  }
}

export function installProviderInstrumentation(): void {
  if (installed) return;
  installed = true;

  diagnosticsChannel.subscribe('undici:request:create', (message) => {
    try {
      const { request } = message as { request: UndiciRequest & object };
      inflight.set(request, {
        start: process.hrtime.bigint(),
        provider: providerForOrigin(request.origin),
        method: String(request.method ?? 'GET')
          .toUpperCase()
          .slice(0, 10),
        operation: operationTemplate(request.path),
      });
    } catch {
      // never affect the request
    }
  });

  diagnosticsChannel.subscribe('undici:request:headers', (message) => {
    try {
      const { request, response } = message as {
        request: object;
        response: { statusCode: number };
      };
      finish(request, classifyStatus(response.statusCode), response.statusCode);
    } catch {
      // never affect the request
    }
  });

  diagnosticsChannel.subscribe('undici:request:error', (message) => {
    try {
      const { request, error } = message as { request: object; error: unknown };
      const code = (error as { code?: string } | null)?.code;
      finish(
        request,
        classifyError(error),
        undefined,
        typeof code === 'string' ? code.slice(0, 48) : undefined,
      );
    } catch {
      // never affect the request
    }
  });
}
