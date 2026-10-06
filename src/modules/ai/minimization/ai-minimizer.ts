import type {
  AiChatMessage,
  AiToolCall,
} from '../providers/ai-provider.interface';
import {
  DIGIT_RUN_SOURCE,
  EMAIL_SOURCE,
  EPOCH_MS_SOURCE,
  toAsciiDigits,
} from '../../../common/utils/log-scrubber.util';

/**
 * Data minimisation in front of the AI provider (residency plan P2).
 *
 * The model never needs a patient's real identifiers to do its job. It needs
 * to know THAT there is a phone number to pass to `book_public_appointment`, not
 * what the digits are. So everything identifier-shaped is replaced by an opaque
 * token on the way out, and the tokens are put back on the way in — in the
 * reply text and in tool-call arguments — so the tools still receive real
 * values and the patient still reads their own name.
 *
 *   reversible (token round-trips)   [NAME_n]  [PHONE_n]  [EMAIL_n]
 *   removed (never comes back)       [ID_REMOVED]  [CARD_REMOVED]  [REMOVED]
 *
 * STATELESS BY DESIGN. The token map is rebuilt from the message list on every
 * call, by value, in order of first appearance. Nothing is stored, so there is
 * no token table to secure, retain or delete, and a replayed request produces
 * the same tokens. Rehydrated output is what the executor persists, so the next
 * call re-derives the same map from real history.
 *
 * KNOWN LIMIT, stated plainly: a NAME is only recognised once a structured
 * source has disclosed it (a tool-call argument such as `fullName`, or a tool
 * result field such as `patient_name`) — there is no reliable way to detect an
 * arbitrary name in free text with pattern matching. A patient who types
 * "my name is Sara" and has not yet reached a tool call still sends "Sara".
 * Phones, emails, national IDs, Iqama numbers and card numbers ARE caught by
 * shape wherever they appear.
 */

export interface MinimizationReport {
  names: number;
  phones: number;
  emails: number;
  idsRemoved: number;
  cardsRemoved: number;
  fieldsRemoved: number;
}

/** Argument / result field names whose value is a person's name. Compared normalised. */
const NAME_KEYS = new Set([
  'fullname',
  'patientname',
  'customername',
  'guestname',
  'recipientname',
  'firstname',
  'lastname',
]);

/** Result / argument fields that are removed outright (never tokenised). Compared normalised. */
const REMOVED_KEYS = new Set([
  'nationalid',
  'iqama',
  'iqamanumber',
  'idnumber',
  'passportnumber',
  'dateofbirth',
  'dob',
  'birthdate',
  'insurancenumber',
  'policynumber',
  'memberid',
  'chronicdiseases',
]);

const REMOVED_FIELD = '[REMOVED]';
const ID_REMOVED = '[ID_REMOVED]';
const CARD_REMOVED = '[CARD_REMOVED]';

const TOKEN_RE = /\[(NAME|PHONE|EMAIL)_(\d+)\]/g;
/** Longest possible token, `[PHONE_99999]` — bounds how much a stream rehydrator holds back. */
const MAX_TOKEN_LENGTH = 14;

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]/g, '');

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Kind = 'NAME' | 'PHONE' | 'EMAIL';

/** Splits a JSON string argument/result; `undefined` when it is not JSON. */
function parseJson(text: string | null | undefined): unknown {
  if (!text) return undefined;
  const t = text.trimStart();
  if (t[0] !== '{' && t[0] !== '[') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class MinimizationSession {
  readonly report: MinimizationReport = {
    names: 0,
    phones: 0,
    emails: 0,
    idsRemoved: 0,
    cardsRemoved: 0,
    fieldsRemoved: 0,
  };

  /** token → original value. */
  private readonly reverse = new Map<string, string>();
  /** `${kind}|${lowercased value}` → token. */
  private readonly forward = new Map<string, string>();
  private readonly counters: Record<Kind, number> = {
    NAME: 0,
    PHONE: 0,
    EMAIL: 0,
  };
  private readonly names: Array<{ re: RegExp; token: string }> = [];

  readonly messages: AiChatMessage[];

  constructor(source: AiChatMessage[]) {
    this.harvestNames(source);
    this.messages = source.map((m) => this.minimizeMessage(m));
  }

  /** True when anything at all was tokenised or removed. */
  get changed(): boolean {
    return Object.values(this.report).some((n) => n > 0);
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  private minimizeMessage(m: AiChatMessage): AiChatMessage {
    const out: AiChatMessage = { ...m };

    if (m.content) {
      out.content =
        m.role === 'tool'
          ? this.minimizeToolContent(m.content)
          : this.text(m.content);
    }
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        ...tc,
        arguments: this.minimizeJsonOrText(tc.arguments),
      }));
    }
    return out;
  }

  private minimizeToolContent(content: string): string {
    return this.minimizeJsonOrText(content);
  }

  private minimizeJsonOrText(raw: string): string {
    const parsed = parseJson(raw);
    if (parsed === undefined) return this.text(raw);
    return JSON.stringify(this.walk(parsed));
  }

  private walk(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (
          REMOVED_KEYS.has(normalizeKey(k)) &&
          v !== null &&
          v !== undefined &&
          v !== ''
        ) {
          out[k] = REMOVED_FIELD;
          this.report.fieldsRemoved += 1;
        } else {
          out[k] = this.walk(v);
        }
      }
      return out;
    }
    return value;
  }

  /** Free-text minimisation: emails, then names, then digit runs. */
  private text(input: string): string {
    // Emails FIRST: an address is usually built from the person's name
    // (`sara.ahmed@…`), and replacing the name parts first would mangle the
    // address into something the email pattern no longer recognises.
    let out = input.replace(new RegExp(EMAIL_SOURCE, 'g'), (match) => {
      this.report.emails += 1;
      return this.token('EMAIL', match);
    });

    for (const { re, token } of this.names) {
      out = out.replace(re, () => {
        this.report.names += 1;
        return token;
      });
    }

    const epoch = new RegExp(EPOCH_MS_SOURCE);
    out = out.replace(new RegExp(DIGIT_RUN_SOURCE, 'g'), (match) => {
      const digits = toAsciiDigits(match).replace(/\D/g, '');
      const bare = !/[ +-]/.test(match);
      if (bare && digits.length === 13 && epoch.test(digits)) return match;
      if (bare && digits.length === 10 && /^[12]/.test(digits)) {
        this.report.idsRemoved += 1;
        return ID_REMOVED; // Saudi national ID / Iqama
      }
      if (bare && digits.length === 14 && /^[23]/.test(digits)) {
        this.report.idsRemoved += 1;
        return ID_REMOVED; // Egyptian national ID
      }
      if (digits.length >= 13 && luhn(digits)) {
        this.report.cardsRemoved += 1;
        return CARD_REMOVED;
      }
      if (digits.length > 15) {
        this.report.idsRemoved += 1;
        return ID_REMOVED;
      }
      this.report.phones += 1;
      return this.token('PHONE', match);
    });
    return out;
  }

  private token(kind: Kind, original: string): string {
    const key = `${kind}|${original.toLowerCase().replace(/[\s-]/g, '')}`;
    const existing = this.forward.get(key);
    if (existing) return existing;
    this.counters[kind] += 1;
    const token = `[${kind}_${this.counters[kind]}]`;
    this.forward.set(key, token);
    this.reverse.set(token, original);
    return token;
  }

  // ── Name harvesting ───────────────────────────────────────────────────────

  private harvestNames(source: AiChatMessage[]): void {
    const found = new Set<string>();
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (value === null || typeof value !== 'object') return;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (NAME_KEYS.has(normalizeKey(k)) && typeof v === 'string') {
          this.addName(v, found);
        } else {
          collect(v);
        }
      }
    };

    for (const m of source) {
      for (const tc of m.tool_calls ?? []) collect(parseJson(tc.arguments));
      if (m.role === 'tool') collect(parseJson(m.content));
    }

    // Longest first, so "Sara Ahmed" is replaced before its part "Sara".
    const ordered = [...found].sort((a, b) => b.length - a.length);
    for (const name of ordered) {
      this.counters.NAME += 1;
      const token = `[NAME_${this.counters.NAME}]`;
      this.reverse.set(token, name);
      this.names.push({
        re: new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`,
          'giu',
        ),
        token,
      });
    }
  }

  private addName(value: string, into: Set<string>): void {
    const full = value.trim().replace(/\s+/g, ' ');
    if (full.length < 2 || full.length > 80 || !/\p{L}/u.test(full)) return;
    const have = new Set([...into].map((n) => n.toLowerCase()));
    const add = (s: string) => {
      if (!have.has(s.toLowerCase())) {
        into.add(s);
        have.add(s.toLowerCase());
      }
    };
    add(full);
    for (const part of full.split(' ')) {
      if (part.length >= 3 && /\p{L}/u.test(part)) add(part);
    }
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  /** Puts reversible tokens back. Unknown tokens (a hallucinated `[PHONE_9]`) are left untouched. */
  rehydrate(text: string): string {
    if (!text || this.reverse.size === 0) return text;
    return text.replace(TOKEN_RE, (m) => this.reverse.get(m) ?? m);
  }

  /** Rehydrates a tool-call's raw JSON arguments so the tool receives real values. */
  rehydrateArguments(args: string): string {
    if (!args || this.reverse.size === 0) return args;
    const parsed = parseJson(args);
    if (parsed === undefined) {
      // Not JSON — substitute with each value JSON-escaped so the string stays valid.
      return args.replace(TOKEN_RE, (m) => {
        const v = this.reverse.get(m);
        return v === undefined ? m : JSON.stringify(v).slice(1, -1);
      });
    }
    const back = (v: unknown): unknown => {
      if (typeof v === 'string') return this.rehydrate(v);
      if (Array.isArray(v)) return v.map(back);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, x]) => [
            k,
            back(x),
          ]),
        );
      }
      return v;
    };
    return JSON.stringify(back(parsed));
  }

  rehydrateToolCalls(calls?: AiToolCall[]): AiToolCall[] | undefined {
    if (!calls?.length) return calls;
    return calls.map((c) => ({
      ...c,
      arguments: this.rehydrateArguments(c.arguments),
    }));
  }

  /**
   * Streaming rehydration. A token can be split across deltas (`[PHO` + `NE_1]`),
   * so a trailing fragment that could still become a token is held back until
   * the next delta resolves it. Output order and content are otherwise unchanged.
   */
  streamRehydrator(): { push(delta: string): string; flush(): string } {
    let buffer = '';
    return {
      push: (delta: string): string => {
        buffer += delta;
        const open = buffer.lastIndexOf('[');
        const holdFrom =
          open !== -1 &&
          buffer.indexOf(']', open) === -1 &&
          buffer.length - open < MAX_TOKEN_LENGTH
            ? open
            : buffer.length;
        const ready = buffer.slice(0, holdFrom);
        buffer = buffer.slice(holdFrom);
        return this.rehydrate(ready);
      },
      flush: (): string => {
        const rest = buffer;
        buffer = '';
        return this.rehydrate(rest);
      },
    };
  }
}

/** A session that changes nothing — used when minimisation is switched off. */
export function passthroughSession(
  messages: AiChatMessage[],
): Pick<
  MinimizationSession,
  | 'messages'
  | 'rehydrate'
  | 'rehydrateToolCalls'
  | 'streamRehydrator'
  | 'report'
  | 'changed'
> {
  return {
    messages,
    report: {
      names: 0,
      phones: 0,
      emails: 0,
      idsRemoved: 0,
      cardsRemoved: 0,
      fieldsRemoved: 0,
    },
    changed: false,
    rehydrate: (t: string) => t,
    rehydrateToolCalls: (c?: AiToolCall[]) => c,
    streamRehydrator: () => ({ push: (d: string) => d, flush: () => '' }),
  };
}

/**
 * Irreversible scrub for text that is embedded rather than conversed with: there
 * is no reply to rehydrate, so identifiers are simply removed. Names are not
 * detectable here (no structured source), so this covers phones, emails, IDs
 * and card numbers only.
 */
export function scrubForEmbedding(text: string): string {
  const session = new MinimizationSession([{ role: 'user', content: text }]);
  const out = session.messages[0].content ?? '';
  return out
    .replace(/\[PHONE_\d+\]/g, '[PHONE]')
    .replace(/\[EMAIL_\d+\]/g, '[EMAIL]');
}
