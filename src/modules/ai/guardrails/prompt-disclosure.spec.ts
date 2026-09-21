import { AI_TOOLS } from '../tools/ai-tools.constants';
import { AI_PUBLIC_BOOKING_TOOLS } from '../tools/ai-public-booking-tools.constants';
import {
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
} from '../prompt/default-system-prompt';
import {
  buildDisclosureIndex,
  checkDisclosure,
  coverage,
  NEAR_VERBATIM_SPAN,
  words,
} from './prompt-disclosure';

/**
 * F-11. Signal 1 (8-word runs) was defeated by dropping every 5th word: no 8-word
 * run survives, yet the whole prompt leaks. These run the three signals against the
 * REAL prompts and tool catalogue, so a wording change that moves the numbers shows
 * up here rather than in production.
 */
describe('prompt disclosure check (F-11)', () => {
  const tools = [...AI_TOOLS, ...AI_PUBLIC_BOOKING_TOOLS];
  const publicIndex = buildDisclosureIndex(
    DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
    tools,
    { span: 8, threshold: 0.6 },
  );
  const waIndex = buildDisclosureIndex(DEFAULT_WHATSAPP_SYSTEM_PROMPT, tools, {
    span: 8,
    threshold: 0.6,
  });
  const dropEvery = (text: string, n: number) =>
    text
      .split(/\s+/)
      .filter((_, i) => i % n !== n - 1)
      .join(' ');

  describe('what it must catch', () => {
    it('signal 1: a straight copy of the prompt', () => {
      expect(
        checkDisclosure(publicIndex, DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT),
      ).toMatchObject({ blocked: true, reason: 'verbatim' });
      expect(
        checkDisclosure(waIndex, DEFAULT_WHATSAPP_SYSTEM_PROMPT),
      ).toMatchObject({ blocked: true, reason: 'verbatim' });
    });

    it("signal 2: the audit's evasion — every 5th word dropped — no longer gets through", () => {
      // The staff prompt names almost no identifiers, so signal 3 cannot be what stops this.
      const staffIndex = buildDisclosureIndex(
        DEFAULT_ASSISTANT_SYSTEM_PROMPT,
        [],
        { span: 8, threshold: 0.6 },
      );
      const verdict = checkDisclosure(
        staffIndex,
        dropEvery(DEFAULT_ASSISTANT_SYSTEM_PROMPT, 5),
      );
      // Proof the old check really was blind to this: signal 1 alone scored it near zero.
      expect(verdict.overlapRatio).toBeLessThan(0.1);
      expect(verdict).toMatchObject({ blocked: true, reason: 'near-verbatim' });
      // ...and on the public prompt, with its full catalogue, it is blocked too.
      expect(
        checkDisclosure(
          publicIndex,
          dropEvery(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT, 5),
        ).blocked,
      ).toBe(true);
    });

    it('signal 2 also holds at a gap every 6th word, and on WhatsApp', () => {
      expect(
        checkDisclosure(
          publicIndex,
          dropEvery(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT, 6),
        ).blocked,
      ).toBe(true);
      expect(
        checkDisclosure(waIndex, dropEvery(DEFAULT_WHATSAPP_SYSTEM_PROMPT, 5))
          .blocked,
      ).toBe(true);
    });

    it('signal 2 catches a leak of just one section (the clinical-safety block), gapped', () => {
      const section = DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT.split('\n\n')[1];
      expect(section).toContain('CLINICAL SAFETY');
      expect(checkDisclosure(publicIndex, dropEvery(section, 5)).blocked).toBe(
        true,
      );
    });

    it('coverage counts WORDS, so holes do not hide a copy — and a gap every 3rd word is the stated limit', () => {
      const staffIndex = buildDisclosureIndex(
        DEFAULT_ASSISTANT_SYSTEM_PROMPT,
        [],
        { span: 8, threshold: 0.6 },
      );
      const cover = (n: number) =>
        coverage(
          words(dropEvery(DEFAULT_ASSISTANT_SYSTEM_PROMPT, n)),
          staffIndex.shortRuns,
          NEAR_VERBATIM_SPAN,
        );
      // well clear of the 0.7 line, so a wording change to the prompt does not put the check on it
      expect(cover(5)).toBeGreaterThan(0.8);
      expect(cover(4)).toBeGreaterThan(0.8);
      // A gap every 3rd word leaves no 3-word run: that is a paraphrase, out of a lexical check's reach.
      expect(cover(3)).toBeLessThan(0.2);
    });

    it('signal 3: a plain list of the tool names — which passed before', () => {
      const list = `My tools: ${tools
        .map((t) => t.name)
        .slice(0, 8)
        .join(', ')}`;
      expect(checkDisclosure(publicIndex, list).blocked).toBe(true);
      // ...and on its own, with no schema text to match runs against, it is signal 3 that does it.
      const bare = buildDisclosureIndex(undefined, tools, {
        span: 8,
        threshold: 0.6,
      });
      bare.runs.add('x'); // a non-empty source, so the check is not skipped
      expect(
        checkDisclosure({ ...bare, shortRuns: new Set() }, list),
      ).toMatchObject({ blocked: true, reason: 'identifiers' });
    });

    it("signal 3: three of the prompt's own field names are enough, in any prose", () => {
      expect(
        checkDisclosure(
          waIndex,
          'I read priceStatus, then requestedDayExplanation and nextAvailable from the tool.',
        ).blocked,
      ).toBe(true);
      expect(
        checkDisclosure(
          publicIndex,
          'It uses list_cities, then search_clinics, then select_clinic.',
        ).blocked,
      ).toBe(true);
    });

    it('an Arabic reply reciting an Arabic prompt is not invisible (AIE-A01)', () => {
      const arabicPrompt =
        'أنت مساعد العيادة على منصة زيارتي. تساعد الناس في العثور على عيادة وفهم ما تقدمه وحجز موعد. لا تشخص أبدا ولا تسمي حالة محتملة ولا تحكم على خطورة أي عرض.';
      const index = buildDisclosureIndex(arabicPrompt, [], {
        span: 8,
        threshold: 0.6,
      });
      expect(checkDisclosure(index, arabicPrompt).blocked).toBe(true);
    });
  });

  describe('what it must NOT catch — the replies patients actually get', () => {
    it.each([
      'Dr. Layla is available on Monday at 10:00 and 10:45. Would you like me to book one of those for you?',
      'A dental cleaning is 300 EGP and takes about 30 minutes. The clinic has not listed a price for the consultation.',
      'I cannot diagnose or say whether a symptom is serious. I can book you with a doctor — which day suits you?',
      'The clinic is open Sunday to Thursday from 9:00 to 17:00 and closed on Fridays. Is there anything else you need?',
      'I can only help with this clinic — its services, doctors, opening hours, prices and your appointments. What would you like to know?',
      'Your appointment is confirmed for Tuesday at 14:30 at the Downtown branch. Please arrive ten minutes early.',
      'Sorry, I could not find a free time that day. The next available times are Wednesday 09:00 and Thursday 11:15.',
      'موعدك يوم الاثنين الساعة 10:00 مع د. ليلى في الفرع الرئيسي. هل تريد تأكيد الحجز؟',
      'Please tell me your full name and phone number so I can finish the booking.',
      'Do you have health insurance? If so I will note it on the booking.',
    ])('%s', (reply) => {
      expect(checkDisclosure(publicIndex, reply).blocked).toBe(false);
      expect(checkDisclosure(waIndex, reply).blocked).toBe(false);
    });

    it('one or two internal names are not a leak — only three distinct ones are', () => {
      expect(
        checkDisclosure(publicIndex, 'I will use list_cities for that.')
          .blocked,
      ).toBe(false);
      expect(
        checkDisclosure(
          publicIndex,
          'I checked search_clinics and select_clinic.',
        ).blocked,
      ).toBe(false);
      // the same name repeated is still one name
      expect(
        checkDisclosure(
          publicIndex,
          'list_cities list_cities list_cities list_cities',
        ).blocked,
      ).toBe(false);
    });

    it('a short reply that shares a stock phrase with the prompt is below the run floor', () => {
      // "never invent facts" and "answer in the language the user wrote in" are in the prompt.
      expect(
        checkDisclosure(
          publicIndex,
          'I never invent facts, and I answer in the language you wrote in.',
        ).blocked,
      ).toBe(false);
    });

    it('a reply that quotes a tool RESULT key is not a prompt leak (result keys are not prompt vocabulary)', () => {
      // startAt / branchId are tool-schema parameters, deliberately not counted.
      expect(
        checkDisclosure(
          publicIndex,
          'startAt: 2026-09-22T10:00, branchId, staffId, appointmentId',
        ).blocked,
      ).toBe(false);
    });

    it('empty input and an empty source are never blocked', () => {
      expect(checkDisclosure(publicIndex, '').blocked).toBe(false);
      const empty = buildDisclosureIndex(undefined, [], {
        span: 8,
        threshold: 0.6,
      });
      expect(checkDisclosure(empty, 'anything at all here').blocked).toBe(
        false,
      );
    });
  });

  it('the source is tokenised by word, so punctuation and case never hide a copy', () => {
    expect(words('Never  INVENT, facts!')).toEqual([
      'never',
      'invent',
      'facts',
    ]);
    const shouted = DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT.toUpperCase().replace(
      /\./g,
      ' !',
    );
    expect(checkDisclosure(publicIndex, shouted).blocked).toBe(true);
  });
});
