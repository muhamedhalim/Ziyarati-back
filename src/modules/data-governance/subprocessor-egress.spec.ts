import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import {
  EVIDENCE_FIELDS,
  hostMatches,
  processorForHost,
  processorsMissingEvidence,
  SUBPROCESSORS,
} from './subprocessor-register';

/**
 * Residency plan P15 — the register is tied to what the code actually does.
 * Three scans over the real source: hostname literals, outbound-call files and
 * vendor SDK dependencies. A new external party that is not in the register
 * fails here.
 */

const SRC = join(__dirname, '..', '..');
const ROOT = join(SRC, '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === 'migrations') continue;
      sourceFiles(full, out);
    } else if (
      name.endsWith('.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.test-util.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC);
const rel = (f: string) => relative(SRC, f).split(sep).join('/');

/** Hosts that are placeholders, the platform's own, or loopback — never a third party. */
function isNeutralHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test') ||
    host.endsWith('.example') ||
    host === 'example.com' ||
    host.endsWith('.example.com') ||
    host === 'ziyaratech.com' ||
    host.endsWith('.ziyaratech.com')
  );
}

describe('subprocessor register ↔ code', () => {
  it('finds source files (the scan is not vacuous)', () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('accounts for every hostname literal in non-test source', () => {
    const unaccounted = new Map<string, string[]>();
    for (const file of FILES) {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        // Comment and doc lines cite URLs as references, not as destinations.
        if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//'))
          continue;
        for (const m of line.matchAll(
          /https?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
        )) {
          const host = m[1].toLowerCase();
          if (isNeutralHost(host) || processorForHost(host)) continue;
          unaccounted.set(host, [...(unaccounted.get(host) ?? []), rel(file)]);
        }
      }
    }
    // Names the host AND the file, so the fix (register it, or remove it) is obvious.
    expect(Object.fromEntries(unaccounted)).toEqual({});
  });

  /**
   * Every file that makes an outbound call or builds a cloud/vendor client, and
   * which register entry covers it. `internal` = a false positive of the scan
   * (an inbound server, or a destination check that makes no call).
   */
  const OUTBOUND: Record<string, string> = {
    'metrics/start-metrics-http-server.ts': 'internal',
    'modules/ai-realtime/ws-handshake-admission.ts': 'internal',
    'modules/ai/providers/openai-batch.provider.ts': 'openai',
    'modules/ai/providers/openai-chat.provider.ts': 'openai',
    'modules/ai/providers/openai-client.provider.ts': 'openai',
    'modules/ai/providers/openai-embedding.provider.ts': 'openai',
    'modules/email/feedback/ses-feedback.consumer.ts': 'aws',
    'modules/email/providers/resend.provider.ts': 'resend',
    'modules/email/providers/ses.provider.ts': 'aws',
    'modules/integration-platform/providers/generic-rest-http-client.ts':
      'tenant-configured',
    'modules/notifications/channels/meta-whatsapp-cloud.provider.ts':
      'meta-whatsapp',
    'modules/payments/preflight/tap-preflight.ts': 'tap',
    'modules/platform-usage/usage-report.service.ts': 'internal',
    'modules/platform/webhook-http-client.ts': 'tenant-configured',
    'modules/storage/storage.service.ts': 'aws',
    'modules/whatsapp/meta/meta-graph.client.ts': 'meta-whatsapp',
    'modules/whatsapp/providers/meta-whatsapp.provider.ts': 'meta-whatsapp',
  };

  const OUTBOUND_PATTERN =
    /\bfetch\(|https?\.request|from 'node:https'|from 'https'|from 'node:http'|from 'http'|new (?:S3Client|SESv2Client|SQSClient|OpenAI|Resend)\b|from 'openai'|from '@aws-sdk/;

  it('registers every file that can call out, and lists no file that no longer does', () => {
    const found = FILES.filter((f) =>
      OUTBOUND_PATTERN.test(readFileSync(f, 'utf8')),
    ).map(rel);
    const unregistered = found.filter((f) => !(f in OUTBOUND));
    const stale = Object.keys(OUTBOUND).filter((f) => !found.includes(f));
    expect({ unregistered, stale }).toEqual({ unregistered: [], stale: [] });
  });

  it('maps every outbound file to a real register entry', () => {
    const ids = new Set(SUBPROCESSORS.map((p) => p.id));
    for (const [file, id] of Object.entries(OUTBOUND)) {
      expect(id === 'internal' || ids.has(id)).toBe(true);
      expect(file).toBeTruthy();
    }
  });

  it('has a register entry for each vendor SDK in package.json', () => {
    const deps = Object.keys(
      (
        JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>;
        }
      ).dependencies,
    );
    // vendor package pattern -> register id. A dependency matching a watched
    // pattern without a register entry means a third party was added silently.
    const WATCHED: Array<[RegExp, string]> = [
      [/^openai$/, 'openai'],
      [/^resend$/, 'resend'],
      [/^@aws-sdk\//, 'aws'],
      [/^@sentry\//, 'sentry'],
      [
        /^stripe$|^moyasar$|^twilio$|^@sendgrid\//,
        'payments-or-messaging-vendor',
      ],
      [
        /^mixpanel|^posthog|^@segment\/|^amplitude|^dd-trace$|^newrelic$|^@datadog\//,
        'telemetry-vendor',
      ],
      [/^firebase|^@google-cloud\//, 'google'],
      [/^@vercel\//, 'vercel'],
    ];
    const ids = new Set(SUBPROCESSORS.map((p) => p.id));
    const missing = deps.flatMap((d) =>
      WATCHED.filter(([re]) => re.test(d))
        .filter(([, id]) => !ids.has(id))
        .map(([, id]) => `${d} -> ${id}`),
    );
    expect(missing).toEqual([]);
  });

  it('records no legal evidence as obtained without naming the document', () => {
    for (const p of SUBPROCESSORS) {
      for (const f of EVIDENCE_FIELDS) {
        if (p[f].status === 'obtained')
          expect(p[f].evidence?.trim()).toBeTruthy();
      }
    }
  });

  it('states plainly that no DPA / SCC is held yet — nothing here claims compliance', () => {
    // This test is a tripwire, not a goal: when evidence is genuinely obtained
    // it is updated in the same reviewed change that adds the document.
    const missing = processorsMissingEvidence().map((r) => r.id);
    expect(missing).toEqual(
      expect.arrayContaining([
        'openai',
        'meta-whatsapp',
        'tap',
        'resend',
        'aws',
        'vercel',
      ]),
    );
  });

  it('flags every processor that can receive health data', () => {
    for (const p of SUBPROCESSORS) {
      if (p.dataClasses.includes('D4')) expect(p.healthData).toBe(true);
    }
  });

  it('matches hosts by exact name or *.suffix only', () => {
    expect(hostMatches('api.openai.com', 'api.openai.com')).toBe(true);
    expect(
      hostMatches('s3.eu-central-1.amazonaws.com', '*.amazonaws.com'),
    ).toBe(true);
    expect(hostMatches('amazonaws.com.evil.test', '*.amazonaws.com')).toBe(
      false,
    );
    expect(hostMatches('notapi.openai.com', 'api.openai.com')).toBe(false);
  });
});
