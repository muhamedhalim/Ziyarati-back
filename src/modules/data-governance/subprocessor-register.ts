/**
 * Subprocessor / third-party register (residency plan P15 / section 18).
 *
 * The single in-code list of every external party that can receive data from
 * this backend, or hosts it. `subprocessor-egress.spec.ts` ties it to the code:
 * a hostname literal, an outbound-call file or a vendor SDK dependency that is
 * not accounted for here FAILS the build — so a new processor cannot be added
 * without being written down, and the register cannot drift from what the code
 * actually calls.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is an inventory, not evidence of compliance. Every legal-evidence field
 * below is `to_obtain`: NO DPA, SCC, transfer risk assessment or breach-process
 * document for any provider is held in this repository (plan section 18), and
 * nothing here may be read as saying one exists. Region and retention are `VC`
 * (needs vendor confirmation) until a written vendor answer is recorded.
 * A field moves off `to_obtain` only by a reviewed change that names the
 * document in `evidence`.
 */

export type EvidenceStatus = 'to_obtain' | 'obtained';
export type ProcessorState =
  | 'active'
  | 'planned'
  | 'legacy'
  | 'tenant_configured';

export interface EvidenceItem {
  status: EvidenceStatus;
  /** Path or contract reference once obtained. Required when `status` is `obtained`. */
  evidence?: string;
}

export interface Subprocessor {
  id: string;
  name: string;
  purpose: string;
  state: ProcessorState;
  /** Data classes (data-classification.ts) that can reach it. */
  dataClasses: string[];
  /** Plan section 6 flow ids this processor appears in. */
  flows: string[];
  /** True when health data (D4) can reach it. */
  healthData: boolean;
  /** Hosts this code calls. Exact, or `*.suffix`. Empty for non-egress infrastructure. */
  egressHosts: string[];
  /** Hosts that appear in source only as documentation / provenance and are never called. */
  referenceHosts: string[];
  /** Where the data is stored / processed. `VC` = needs vendor confirmation. */
  region: string;
  retention: string;
  /** The Ziyarati-side control that limits what reaches it. */
  control: string;
  dpa: EvidenceItem;
  scc: EvidenceItem;
  transferRiskAssessment: EvidenceItem;
  subprocessorList: EvidenceItem;
  breachProcess: EvidenceItem;
  note?: string;
}

const TO_OBTAIN: EvidenceItem = { status: 'to_obtain' };

function proc(
  p: Omit<
    Subprocessor,
    | 'dpa'
    | 'scc'
    | 'transferRiskAssessment'
    | 'subprocessorList'
    | 'breachProcess'
    | 'referenceHosts'
  > & { referenceHosts?: string[] },
): Subprocessor {
  return {
    referenceHosts: [],
    dpa: TO_OBTAIN,
    scc: TO_OBTAIN,
    transferRiskAssessment: TO_OBTAIN,
    subprocessorList: TO_OBTAIN,
    breachProcess: TO_OBTAIN,
    ...p,
  };
}

export const SUBPROCESSORS: readonly Subprocessor[] = [
  proc({
    id: 'openai',
    name: 'OpenAI',
    purpose: 'AI chat, optional vision, embeddings, batch',
    state: 'active',
    dataClasses: ['D2', 'D4'],
    flows: ['F8', 'F9', 'F10'],
    healthData: true,
    // The SDK's default endpoint; a per-tenant deployment may override the base URL.
    egressHosts: ['api.openai.com'],
    referenceHosts: ['openai.com'],
    region: 'VC',
    retention: 'VC (zero-retention option not evidenced)',
    control:
      'AI minimiser (names/phones/emails tokenised; IDs, cards, DOB removed); vision off by default',
  }),
  proc({
    id: 'meta-whatsapp',
    name: 'Meta (WhatsApp Business Cloud API)',
    purpose: 'Patient messaging',
    state: 'active',
    dataClasses: ['D2'],
    flows: ['F11', 'F12'],
    healthData: false,
    egressHosts: ['graph.facebook.com'],
    referenceHosts: [
      'developers.facebook.com',
      'connect.facebook.net',
      'www.facebook.com',
    ],
    region: 'VC (local storage option does not list Saudi Arabia - OV)',
    retention: 'VC',
    control:
      'WhatsApp content policy at both send seams; marketing needs recorded opt-in',
  }),
  proc({
    id: 'tap',
    name: 'Tap Payments',
    purpose: 'Card payments and payouts',
    state: 'active',
    dataClasses: ['D2', 'D5'],
    flows: ['F13'],
    healthData: false,
    egressHosts: ['api.tap.company'],
    referenceHosts: [
      'developers.tap.company',
      'connect.tap.company',
      'checkout.payments.tap.company',
    ],
    region: 'VC',
    retention: 'VC',
    control:
      'No card number or CVV ever enters this system; hosted payment page only',
  }),
  proc({
    id: 'resend',
    name: 'Resend',
    purpose: 'Transactional email (default provider today)',
    state: 'active',
    dataClasses: ['D2'],
    flows: ['F14'],
    healthData: false,
    egressHosts: ['api.resend.com'],
    region: 'VC',
    retention: 'VC',
    control:
      'Minimal appointment notices (no service, doctor or reason); identifiers redacted from free text',
  }),
  proc({
    id: 'aws',
    name: 'Amazon Web Services',
    purpose: 'Hosting (planned), SES email, S3 storage, SQS feedback queue',
    state: 'planned',
    dataClasses: ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'],
    flows: ['F5', 'F6', 'F7', 'F14', 'F15', 'F16', 'F17'],
    healthData: true,
    egressHosts: ['*.amazonaws.com'],
    region:
      'Not decided - no KSA Region exists; see the residency plan and L1/L2',
    retention:
      'Configured by us (backups 14 days planned; clinical retention undefined - L12)',
    control:
      'Region allow-list, single-Region keys, replication denied, SCPs (written, not applied)',
  }),
  proc({
    id: 'cloudflare-r2',
    name: 'Cloudflare R2',
    purpose: 'Object storage today (patient documents, attachments)',
    state: 'active',
    dataClasses: ['D2', 'D4'],
    flows: ['F7'],
    healthData: true,
    egressHosts: ['*.r2.cloudflarestorage.com'],
    region: 'VC',
    retention: 'Indefinite (no lifecycle policy)',
    control:
      'To be replaced by S3 in the approved Region; deletion evidence required afterwards',
  }),
  proc({
    id: 'railway',
    name: 'Railway',
    purpose: 'Compute, PostgreSQL and Redis today',
    state: 'active',
    dataClasses: ['D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'],
    flows: ['F5', 'F6', 'F15', 'F16'],
    healthData: true,
    egressHosts: [],
    region: 'VC',
    retention: 'VC',
    control:
      'Infrastructure host; no code path calls it. To be decommissioned with deletion evidence.',
  }),
  proc({
    id: 'vercel',
    name: 'Vercel',
    purpose: 'Frontend hosting; proxies REST today; analytics',
    state: 'active',
    dataClasses: ['D2', 'D4', 'D6'],
    flows: ['F1', 'F2', 'F3'],
    healthData: true,
    egressHosts: [],
    region: 'VC',
    retention: 'VC (logs)',
    control:
      'Direct API routing removes REST from the path; analytics limited to public pages',
  }),
  proc({
    id: 'github',
    name: 'GitHub',
    purpose: 'Source hosting and CI',
    state: 'active',
    dataClasses: ['D1', 'D6'],
    flows: ['F18'],
    healthData: false,
    egressHosts: [],
    region: 'VC',
    retention: 'Artifacts per repository policy',
    control:
      'No patient data in CI; Terraform plan artifacts are treated as D6',
  }),
  proc({
    id: 'tenant-configured',
    name: 'Clinic-configured partner endpoints',
    purpose:
      'Outbound webhooks and generic REST integrations to a destination the CLINIC chooses',
    state: 'tenant_configured',
    dataClasses: ['D2'],
    flows: [],
    healthData: false,
    egressHosts: [],
    region: 'Chosen by the clinic',
    retention: 'Chosen by the clinic',
    control:
      'SSRF-guarded destinations; the clinic is the controller of that transfer',
    note: 'The destination host is data, not code, so it cannot be listed here.',
  }),
];

const BY_ID = new Map(SUBPROCESSORS.map((p) => [p.id, p]));

export function getSubprocessor(id: string): Subprocessor | undefined {
  return BY_ID.get(id);
}

/** True when `host` matches an exact entry or a `*.suffix` entry. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

/** The processor that owns `host`, whether as an egress or a reference host. */
export function processorForHost(host: string): Subprocessor | undefined {
  return SUBPROCESSORS.find((p) =>
    [...p.egressHosts, ...p.referenceHosts].some((pat) =>
      hostMatches(host, pat),
    ),
  );
}

export const EVIDENCE_FIELDS = [
  'dpa',
  'scc',
  'transferRiskAssessment',
  'subprocessorList',
  'breachProcess',
] as const;

/** Processors still missing at least one evidence item — the production-gate input. */
export function processorsMissingEvidence(): Array<{
  id: string;
  missing: string[];
}> {
  return SUBPROCESSORS.filter((p) => p.state !== 'tenant_configured')
    .map((p) => ({
      id: p.id,
      missing: EVIDENCE_FIELDS.filter(
        (f) => p[f].status !== 'obtained',
      ) as string[],
    }))
    .filter((r) => r.missing.length > 0);
}
