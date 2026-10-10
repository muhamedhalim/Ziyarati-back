import {
  DATA_CLASSIFICATION,
  NEVER_EXTERNAL_BY_DEFAULT,
} from './data-classification';
import {
  NEVER_AUTO_PURGED,
  RETENTION_TARGETS,
  settingFor,
} from './retention-policy';
import { EVIDENCE_FIELDS, SUBPROCESSORS } from './subprocessor-register';

/**
 * Renders the tables embedded in infra/docs/*.md from the code registers, so a
 * document cannot drift from the register it describes.
 * `compliance-docs.spec.ts` compares each rendered block with the marked block
 * in the document and fails with the command that rewrites it.
 */

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

export function renderSubprocessors(): string {
  return table(
    [
      'Id',
      'Processor',
      'State',
      'Data classes',
      'Health data',
      'Flows',
      'Region',
      'Retention',
      'Ziyarati-side control',
      'Evidence still to obtain',
    ],
    SUBPROCESSORS.map((p) => {
      const missing =
        p.state === 'tenant_configured'
          ? ['n/a (clinic is the controller)']
          : EVIDENCE_FIELDS.filter((f) => p[f].status !== 'obtained');
      return [
        `\`${p.id}\``,
        p.name,
        p.state,
        p.dataClasses.join(', ') || '-',
        p.healthData ? 'yes' : 'no',
        p.flows.join(', ') || '-',
        p.region,
        p.retention,
        p.control,
        missing.length ? missing.join(', ') : 'none',
      ];
    }),
  );
}

export function renderClassificationSummary(): string {
  const counts = new Map<string, number>();
  for (const row of DATA_CLASSIFICATION)
    for (const c of row.classes) counts.set(c, (counts.get(c) ?? 0) + 1);
  const rows = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, n]) => [c, String(n)]);
  return [
    `Tables classified: ${DATA_CLASSIFICATION.length}. A table counts under every class it can hold.`,
    '',
    table(['Class', 'Tables'], rows),
    '',
    `Never sent outside the boundary by default: ${NEVER_EXTERNAL_BY_DEFAULT.join(', ')}.`,
  ].join('\n');
}

export function renderClassificationTables(): string {
  return table(
    ['Table', 'Classes', 'Whose data', 'Purpose'],
    DATA_CLASSIFICATION.map((r) => [
      `\`${r.table}\``,
      r.classes.join(', '),
      r.subjects.join(', ') || '-',
      r.purpose,
    ]),
  );
}

export function renderRetentionTargets(): string {
  return [
    table(
      [
        'Target',
        'Table',
        'Action',
        'Classes',
        'Setting (unset = keep)',
        'Measured on',
        'Why it is safe to age out',
      ],
      RETENTION_TARGETS.map((t) => [
        `\`${t.id}\``,
        `\`${t.table}\``,
        t.action,
        t.dataClasses.join(', '),
        `\`${settingFor(t)}\``,
        `\`${t.timestampColumn}\``,
        t.rationale,
      ]),
    ),
    '',
    'Never aged out by a schedule:',
    '',
    table(
      ['Scope', 'Reason'],
      NEVER_AUTO_PURGED.map((n) => [n.scope, n.reason]),
    ),
  ].join('\n');
}

export const GENERATED_BLOCKS: ReadonlyArray<{
  file: string;
  name: string;
  render: () => string;
}> = [
  {
    file: 'SUBPROCESSORS.md',
    name: 'subprocessors',
    render: renderSubprocessors,
  },
  {
    file: 'DATA-CLASSIFICATION.md',
    name: 'classification-summary',
    render: renderClassificationSummary,
  },
  {
    file: 'DATA-CLASSIFICATION.md',
    name: 'classification-tables',
    render: renderClassificationTables,
  },
  {
    file: 'RETENTION-POLICY.md',
    name: 'retention-targets',
    render: renderRetentionTargets,
  },
];
