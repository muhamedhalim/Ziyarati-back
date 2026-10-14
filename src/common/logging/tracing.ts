/* eslint-disable @typescript-eslint/no-require-imports */
import { trace, isSpanContextValid } from '@opentelemetry/api';

import { scrubText } from '../utils/log-scrubber.util';
import { redactUrlForLog } from '../utils/sanitize.util';
import {
  isDeployedEnv,
  resolveLogConfig,
  type ProcessRole,
} from './log-config';

/**
 * Optional OpenTelemetry tracing (OFF unless `OTEL_ENABLED=true`).
 *
 * MUST be started before anything requires `http`, `express`, `pg` or
 * `ioredis` — that is why `tracing-api.ts` / `tracing-worker.ts` are the FIRST
 * import of `main.ts` / `worker.ts`, and why this file imports nothing heavier
 * than `@opentelemetry/api` (the SDK is `require`d lazily, only when enabled).
 *
 * Instrumented: incoming/outgoing `http`, Express routing, `pg` queries,
 * `ioredis` commands, `fetch` (undici), and one span per BullMQ job
 * (job-instrumentation.ts) so a job's queries and provider calls share a
 * trace. NOT propagated: API → queue → worker (jobs carry the request id as
 * `correlationId`, which is the cross-boundary key; see LOGGING.md).
 *
 * Privacy (LOGGING-SECURITY-AUDIT LSA-03): every span passes through
 * `SanitizingSpanProcessor` before export — URL attributes keep the route
 * template (or a path whose dynamic segments are `:param`), never a query
 * string, capability token, phone or name; `client.address`, user agent and
 * header attributes are dropped; exception events and error status keep the
 * error TYPE only (no message, no stack); SQL text has its string literals
 * replaced; every remaining string is shape-scrubbed. Redis spans record the
 * command name only; pg spans never carry parameter values
 * (`enhancedDatabaseReporting: false`).
 *
 * Destination guard: in a deployed environment (production/staging) tracing
 * starts ONLY if the OTLP endpoint is `https://` and its host is listed in
 * `OTEL_ALLOWED_COLLECTOR_HOSTS`; otherwise it refuses to start (the app keeps
 * running) and says why. OTEL_ENABLED stays unset in deployed environments
 * until the conditions in docs/LOGGING-PRIVACY-REMEDIATION.md are met.
 *
 * Sampling: parent-based, root ratio `OTEL_TRACES_SAMPLER_ARG` (default 0.1 in
 * deployed environments, 1.0 locally). Export: OTLP/HTTP to the standard
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS` for auth),
 * batched and bounded; an unreachable collector drops spans, never requests.
 */
let enabled = false;
let provider: { shutdown(): Promise<void> } | undefined;

export function isTracingEnabled(): boolean {
  return enabled;
}

/** Ids of the active, valid span — read by the logger for `trace_id` / `span_id`. */
export function activeSpanIds():
  | { trace_id: string; span_id: string }
  | undefined {
  if (!enabled) return undefined;
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !isSpanContextValid(ctx)) return undefined;
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

/** Removes the query string and fragment from an absolute or relative URL. */
export function stripQuery(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  return url.split('?')[0].split('#')[0];
}

export type ExporterDecision =
  | { url: string; refused?: undefined }
  | { url?: undefined; refused: string };

/**
 * Where spans may be sent (LSA-03). Deployed: `https://` to an allow-listed
 * host only — nothing is exported over plaintext or to an endpoint someone
 * merely put in an environment variable. Local: http(s) anywhere (the
 * observability stack in `observability/`). Credentials in the URL are always
 * refused.
 */
export function resolveTraceExporterUrl(
  env: NodeJS.ProcessEnv,
  deployed: boolean,
): ExporterDecision {
  const traces = (env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? '').trim();
  const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  const raw = traces || (base ? `${base.replace(/\/+$/, '')}/v1/traces` : '');
  if (!raw) {
    return deployed
      ? { refused: 'no_endpoint' }
      : { url: 'http://localhost:4318/v1/traces' };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { refused: 'invalid_endpoint' };
  }
  if (url.username || url.password) return { refused: 'credentials_in_url' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { refused: 'unsupported_scheme' };
  if (!deployed) return { url: url.toString() };
  if (url.protocol !== 'https:') return { refused: 'insecure_transport' };
  const allowed = (env.OTEL_ALLOWED_COLLECTOR_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return { refused: 'no_collector_allowlist' };
  if (!allowed.includes(url.hostname.toLowerCase()))
    return { refused: 'collector_not_allowlisted' };
  return { url: url.toString() };
}

/** URL/path with no query, no userinfo and every dynamic segment replaced by `:param`. */
export function redactPathForSpan(url: unknown): string | undefined {
  return typeof url === 'string' ? redactUrlForLog(url) : undefined;
}

const DROPPED_ATTRIBUTES = new Set([
  'client.address',
  'client.port',
  'http.client_ip',
  'user_agent.original',
  'http.user_agent',
  'enduser.id',
  'url.query',
]);
const DROPPED_ATTRIBUTE_PREFIXES = [
  'http.request.header.',
  'http.response.header.',
];
const URL_ATTRIBUTES = new Set([
  'url.full',
  'http.url',
  'url.path',
  'http.target',
]);
const SQL_ATTRIBUTES = new Set(['db.query.text', 'db.statement']);
/**
 * Allow-list by semantic-convention namespace: an attribute outside these is
 * dropped, so a future `span.setAttribute('patient_name', …)` or an
 * instrumentation upgrade that adds a new free-text attribute is not exported
 * by default.
 */
const ALLOWED_ATTRIBUTE_PREFIXES = [
  'http.',
  'url.',
  'server.',
  'net.',
  'network.',
  'db.',
  'express.',
  'messaging.',
  'rpc.',
  'error.',
  'otel.',
  'exception.',
];
const MAX_ATTRIBUTE_LENGTH = 1_024;

function scrubAttributeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const s = scrubText(value);
    return s.length > MAX_ATTRIBUTE_LENGTH
      ? `${s.slice(0, MAX_ATTRIBUTE_LENGTH)}…`
      : s;
  }
  if (Array.isArray(value)) return value.map(scrubAttributeValue);
  return value;
}

/** Mutable view of an SDK span at `onEnd` (the SDK's `SpanImpl` fields). */
interface MutableSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: { name: string; attributes?: Record<string, unknown> }[];
  status: { code: number; message?: string };
}

/**
 * Rewrites a finished span in place so that only allow-listed, value-free
 * data is exported. Never throws.
 */
export function sanitizeSpanForExport(span: MutableSpan): void {
  try {
    const attrs = span.attributes ?? {};
    const route =
      typeof attrs['http.route'] === 'string'
        ? (redactPathForSpan(attrs['http.route']) as string)
        : undefined;
    for (const key of Object.keys(attrs)) {
      if (
        DROPPED_ATTRIBUTES.has(key) ||
        DROPPED_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p)) ||
        !ALLOWED_ATTRIBUTE_PREFIXES.some((p) => key.startsWith(p))
      ) {
        delete attrs[key];
      } else if (URL_ATTRIBUTES.has(key)) {
        const isPathOnly = key === 'url.path' || key === 'http.target';
        attrs[key] =
          isPathOnly && route ? route : (redactPathForSpan(attrs[key]) ?? '');
      } else if (SQL_ATTRIBUTES.has(key) && typeof attrs[key] === 'string') {
        attrs[key] = scrubAttributeValue(
          (attrs[key] as string).replace(/'(?:[^']|'')*'/g, "'?'"),
        );
      } else {
        attrs[key] = scrubAttributeValue(attrs[key]);
      }
    }

    let errorType: string | undefined;
    for (const event of span.events ?? []) {
      const ea = event.attributes;
      if (!ea) continue;
      if (event.name === 'exception') {
        if (typeof ea['exception.type'] === 'string') {
          errorType = scrubText(ea['exception.type']).slice(0, 64);
          ea['exception.type'] = errorType;
        }
        delete ea['exception.message'];
        delete ea['exception.stacktrace'];
      }
      for (const key of Object.keys(ea)) ea[key] = scrubAttributeValue(ea[key]);
    }

    if (span.status && span.status.message !== undefined) {
      span.status = { code: span.status.code, message: errorType ?? 'error' };
    }
    // Only URL-shaped parts of the name (`GET /a/b`); `job <queue>/<name>` stays.
    if (typeof span.name === 'string' && span.name.includes('/')) {
      span.name = span.name
        .split(' ')
        .map((part) =>
          part.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(part)
            ? redactPathForSpan(part)
            : part,
        )
        .join(' ');
    }
  } catch {
    // a span that cannot be sanitized is still never allowed to throw here;
    // its URL/exception fields were the first things rewritten above
  }
}

/** Wraps the exporting processor so every span is sanitized before it is queued. */
export class SanitizingSpanProcessor {
  constructor(
    private readonly inner: {
      onStart(span: unknown, ctx: unknown): void;
      onEnd(span: unknown): void;
      forceFlush(): Promise<void>;
      shutdown(): Promise<void>;
    },
  ) {}

  onStart(span: unknown, ctx: unknown): void {
    this.inner.onStart(span, ctx);
  }

  onEnd(span: unknown): void {
    sanitizeSpanForExport(span as MutableSpan);
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function warnTracing(event: string, message: string): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        event,
        message,
      })}\n`,
    );
  } catch {
    // nothing left to do
  }
}

export function startTracing(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (enabled || env.OTEL_ENABLED !== 'true') return;
  const cfg = resolveLogConfig(role, env);
  const deployed = isDeployedEnv(cfg.env, env.NODE_ENV);
  const destination = resolveTraceExporterUrl(env, deployed);
  if (destination.refused !== undefined) {
    // Refuse, never crash: tracing is optional, the application is not.
    warnTracing(
      'tracing.start_refused',
      `OpenTelemetry tracing NOT started: ${destination.refused}. Deployed environments require an https:// OTLP endpoint whose host is listed in OTEL_ALLOWED_COLLECTOR_HOSTS.`,
    );
    return;
  }
  try {
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const {
      BatchSpanProcessor,
      ParentBasedSampler,
      TraceIdRatioBasedSampler,
    } = require('@opentelemetry/sdk-trace-base');
    const {
      OTLPTraceExporter,
    } = require('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const {
      registerInstrumentations,
    } = require('@opentelemetry/instrumentation');
    const {
      HttpInstrumentation,
    } = require('@opentelemetry/instrumentation-http');
    const {
      ExpressInstrumentation,
    } = require('@opentelemetry/instrumentation-express');
    const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
    const {
      IORedisInstrumentation,
    } = require('@opentelemetry/instrumentation-ioredis');
    const {
      UndiciInstrumentation,
    } = require('@opentelemetry/instrumentation-undici');

    const rawRatio = Number(
      env.OTEL_TRACES_SAMPLER_ARG ?? (deployed ? 0.1 : 1),
    );
    const ratio = Number.isFinite(rawRatio)
      ? Math.min(1, Math.max(0, rawRatio))
      : 0.1;

    const tracerProvider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': cfg.service,
        'service.version': cfg.version,
        'deployment.environment.name': cfg.env,
      }),
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(ratio),
      }),
      spanProcessors: [
        new SanitizingSpanProcessor(
          new BatchSpanProcessor(
            // Explicit, validated URL — the exporter must not re-read the
            // endpoint from the environment on its own.
            new OTLPTraceExporter({ url: destination.url }),
            {
              maxQueueSize: 2048,
              maxExportBatchSize: 512,
              scheduledDelayMillis: 5000,
              exportTimeoutMillis: 10_000,
            },
          ),
        ),
      ],
    });
    tracerProvider.register();

    const scrubUrlAttributes = (
      span: { setAttribute(k: string, v: string): void },
      url: string | undefined,
    ) => {
      const clean = redactPathForSpan(url);
      if (clean !== undefined) {
        span.setAttribute('url.full', clean);
        span.setAttribute('http.url', clean);
      }
    };

    registerInstrumentations({
      tracerProvider,
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req: { url?: string }) =>
            /^\/(?:api\/v\d+\/)?(?:health|system\/health|metrics)(?:\/|$|\?)/.test(
              req.url ?? '',
            ),
          requestHook: (
            span: { setAttribute(k: string, v: string): void },
            req: { url?: string; path?: string },
          ) => {
            const target = redactPathForSpan(req.url ?? req.path);
            if (target !== undefined) {
              span.setAttribute('http.target', target);
              span.setAttribute('url.path', target);
            }
          },
        }),
        new ExpressInstrumentation(),
        new PgInstrumentation({
          enhancedDatabaseReporting: false,
          requireParentSpan: true,
        }),
        new IORedisInstrumentation({
          requireParentSpan: true,
          dbStatementSerializer: (cmdName: string) => cmdName,
        }),
        new UndiciInstrumentation({
          // Provider calls are traced inside a request or job span only.
          requireParentSpan: true,
          requestHook: (
            span: { setAttribute(k: string, v: string): void },
            request: { origin?: string; path?: string },
          ) =>
            scrubUrlAttributes(
              span,
              `${request.origin ?? ''}${request.path ?? ''}`,
            ),
        }),
      ],
    });

    provider = tracerProvider;
    enabled = true;
  } catch (err) {
    // Tracing is optional: a missing package or bad config must never stop the app.
    warnTracing(
      'tracing.start_failed',
      `OpenTelemetry tracing could not start: ${(err as Error)?.name ?? 'Error'}`,
    );
  }
}

/** Flushes buffered spans on shutdown; bounded so a dead collector cannot hold the exit. */
export async function shutdownTracing(timeoutMs = 5_000): Promise<void> {
  if (!provider) return;
  await Promise.race([
    provider.shutdown().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
  ]);
}
