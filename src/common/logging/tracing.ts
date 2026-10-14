/* eslint-disable @typescript-eslint/no-require-imports */
import { trace, isSpanContextValid } from '@opentelemetry/api';

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
 * Privacy: query strings are removed from every URL attribute (Meta Graph puts
 * `access_token` there); Redis spans record the command name only; pg spans
 * carry the parameterized SQL text, never parameter values
 * (`enhancedDatabaseReporting: false`). No headers are recorded.
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

export function startTracing(
  role: ProcessRole,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (enabled || env.OTEL_ENABLED !== 'true') return;
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

    const cfg = resolveLogConfig(role, env);
    const deployed = isDeployedEnv(cfg.env, env.NODE_ENV);
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
        new BatchSpanProcessor(new OTLPTraceExporter(), {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
          exportTimeoutMillis: 10_000,
        }),
      ],
    });
    tracerProvider.register();

    const scrubUrlAttributes = (
      span: { setAttribute(k: string, v: string): void },
      url: string | undefined,
    ) => {
      const clean = stripQuery(url);
      if (clean !== undefined) {
        span.setAttribute('url.full', clean);
        span.setAttribute('http.url', clean);
      }
      span.setAttribute('url.query', '');
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
            const target = stripQuery(req.url ?? req.path);
            if (target !== undefined) {
              span.setAttribute('http.target', target);
              span.setAttribute('url.path', target);
            }
            span.setAttribute('url.query', '');
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
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'warn',
        event: 'tracing.start_failed',
        message: `OpenTelemetry tracing could not start: ${(err as Error)?.name ?? 'Error'}`,
      })}\n`,
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
