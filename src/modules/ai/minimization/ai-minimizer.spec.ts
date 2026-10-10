import {
  MinimizationSession,
  passthroughSession,
  scrubForEmbedding,
} from './ai-minimizer';
import type { AiChatMessage } from '../providers/ai-provider.interface';

const NATIONAL_ID = '1012345678';
const EGYPT_ID = '29801011234567';
const PHONE = '0501234567';
const EMAIL = 'sara.ahmed@example.com';
const CARD = '4111 1111 1111 1111';

const wire = (m: AiChatMessage[]) => JSON.stringify(m);

describe('MinimizationSession — outbound', () => {
  it('leaves a message with nothing identifying completely unchanged', () => {
    const messages: AiChatMessage[] = [
      {
        role: 'system',
        content: 'You are the clinic assistant. Open 9:00-17:00.',
      },
      {
        role: 'user',
        content: 'What are your working hours on Friday? Price is 1500 SAR.',
      },
    ];
    const s = new MinimizationSession(messages);
    expect(s.messages).toEqual(messages);
    expect(s.changed).toBe(false);
  });

  it('tokenises phone numbers and emails, and removes IDs and card numbers', () => {
    const s = new MinimizationSession([
      {
        role: 'user',
        content: `My phone is ${PHONE}, email ${EMAIL}, ID ${NATIONAL_ID}, Egyptian ${EGYPT_ID}, card ${CARD}`,
      },
    ]);
    const out = s.messages[0].content!;
    for (const secret of [PHONE, EMAIL, NATIONAL_ID, EGYPT_ID, CARD, '4111']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[PHONE_1]');
    expect(out).toContain('[EMAIL_1]');
    expect(out).toContain('[ID_REMOVED]');
    expect(out).toContain('[CARD_REMOVED]');
    expect(s.report).toMatchObject({
      phones: 1,
      emails: 1,
      idsRemoved: 2,
      cardsRemoved: 1,
    });
  });

  it('catches numbers typed in Arabic-Indic digits', () => {
    const s = new MinimizationSession([
      { role: 'user', content: 'رقمي ٠٥٠١٢٣٤٥٦٧ والهوية ١٠١٢٣٤٥٦٧٨' },
    ]);
    const out = s.messages[0].content!;
    expect(out).not.toMatch(/[٠-٩]{5,}/);
    expect(out).toContain('[PHONE_1]');
    expect(out).toContain('[ID_REMOVED]');
  });

  it('uses one token for the same value however it is formatted', () => {
    const s = new MinimizationSession([
      { role: 'user', content: 'call 0501234567 or 050 123 4567' },
    ]);
    const tokens = s.messages[0].content!.match(/\[PHONE_\d+\]/g)!;
    expect(tokens).toEqual(['[PHONE_1]', '[PHONE_1]']);
  });

  it('is deterministic: the same history always yields the same tokens', () => {
    const history: AiChatMessage[] = [
      { role: 'user', content: `a ${EMAIL} b ${PHONE}` },
      { role: 'assistant', content: 'noted' },
    ];
    const first = new MinimizationSession(history).messages;
    const second = new MinimizationSession(history).messages;
    expect(first).toEqual(second);
  });

  it('keeps millisecond timestamps, UUIDs and short numbers', () => {
    const content =
      'slot 3f2b8c4d-1a2b-4c3d-9e8f-0a1b2c3d4e5f at 1759772000000, 30 minutes, SAR 250';
    expect(
      new MinimizationSession([{ role: 'tool', content }]).messages[0].content,
    ).toBe(content);
  });

  it('does not mutate its input', () => {
    const input: AiChatMessage[] = [{ role: 'user', content: `call ${PHONE}` }];
    const snapshot = JSON.stringify(input);
    new MinimizationSession(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('MinimizationSession — names', () => {
  const bookingHistory: AiChatMessage[] = [
    {
      role: 'user',
      content: 'I would like to book. I am Sara Ahmed, phone 0501234567',
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          name: 'book_public_appointment',
          arguments: JSON.stringify({
            fullName: 'Sara Ahmed',
            phone: PHONE,
            hasInsurance: false,
          }),
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({
        ok: true,
        patient_name: 'Sara Ahmed',
        firstName: 'Sara',
      }),
    },
    {
      role: 'assistant',
      content: 'Thank you Sara, your booking is confirmed.',
    },
  ];

  it('learns a name from a structured source and removes it everywhere, parts included', () => {
    const s = new MinimizationSession(bookingHistory);
    const out = wire(s.messages);
    expect(out).not.toContain('Sara');
    expect(out).not.toContain('Ahmed');
    expect(out).not.toContain(PHONE);
    expect(s.messages[0].content).toMatch(
      /I am \[NAME_\d+\], phone \[PHONE_1\]/,
    );
    expect(s.messages[3].content).toMatch(
      /Thank you \[NAME_\d+\], your booking/,
    );
  });

  it('matches case-insensitively and only whole words', () => {
    const s = new MinimizationSession([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c',
            name: 't',
            arguments: JSON.stringify({ fullName: 'Ali Hassan' }),
          },
        ],
      },
      {
        role: 'user',
        content:
          'ALI is here. Alibaba and Sealing are not names; ali hassan too.',
      },
    ]);
    const content = s.messages[1].content!;
    expect(content).toContain('Alibaba');
    expect(content).toContain('Sealing');
    expect(content).not.toMatch(/\bALI\b/);
    expect(content).not.toMatch(/ali hassan/i);
  });

  it('handles Arabic names', () => {
    const s = new MinimizationSession([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c',
            name: 't',
            arguments: JSON.stringify({ fullName: 'سارة أحمد' }),
          },
        ],
      },
      { role: 'user', content: 'مرحبا أنا سارة أحمد' },
    ]);
    expect(s.messages[1].content).not.toContain('سارة');
    expect(s.messages[1].content).not.toContain('أحمد');
  });

  it('does not treat a clinic or service name as a person', () => {
    const content = 'Noor Dental Clinic offers a Teeth Whitening service';
    const s = new MinimizationSession([
      {
        role: 'tool',
        tool_call_id: 'c',
        content: JSON.stringify({
          clinic: { name: 'Noor Dental Clinic' },
          service: { name: 'Teeth Whitening' },
        }),
      },
      { role: 'assistant', content },
    ]);
    expect(s.messages[1].content).toBe(content);
  });
});

describe('MinimizationSession — tool results', () => {
  it('removes fields that must never be sent and keeps the rest', () => {
    const s = new MinimizationSession([
      {
        role: 'tool',
        tool_call_id: 'c',
        content: JSON.stringify({
          hasInsurance: true,
          national_id: NATIONAL_ID,
          dateOfBirth: '1990-01-01',
          insuranceNumber: 'INS-998877',
          appointmentCount: 3,
          nested: { iqamaNumber: '2123456789' },
        }),
      },
    ]);
    const out = s.messages[0].content!;
    expect(out).not.toContain(NATIONAL_ID);
    expect(out).not.toContain('1990-01-01');
    expect(out).not.toContain('INS-998877');
    expect(out).not.toContain('2123456789');
    expect(JSON.parse(out)).toMatchObject({
      hasInsurance: true,
      appointmentCount: 3,
    });
    expect(s.report.fieldsRemoved).toBe(4);
  });

  it('scrubs a tool result that is not JSON', () => {
    const s = new MinimizationSession([
      { role: 'tool', tool_call_id: 'c', content: `Customer ${PHONE} found` },
    ]);
    expect(s.messages[0].content).toBe('Customer [PHONE_1] found');
  });
});

describe('MinimizationSession — inbound rehydration', () => {
  const history: AiChatMessage[] = [
    { role: 'user', content: `Book me, I am Sara Ahmed, ${PHONE}, ${EMAIL}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c',
          name: 't',
          arguments: JSON.stringify({ fullName: 'Sara Ahmed' }),
        },
      ],
    },
  ];

  it('restores tokens in a reply', () => {
    const s = new MinimizationSession(history);
    const [nameTok] = s.messages[0].content!.match(/\[NAME_\d+\]/g)!;
    expect(
      s.rehydrate(
        `Thanks ${nameTok}, we will text ${'[PHONE_1]'} and mail [EMAIL_1].`,
      ),
    ).toBe(`Thanks Sara Ahmed, we will text ${PHONE} and mail ${EMAIL}.`);
  });

  it('restores tokens inside tool-call arguments so the tool receives real values', () => {
    const s = new MinimizationSession(history);
    const args = JSON.stringify({
      fullName: '[NAME_1]',
      phone: '[PHONE_1]',
      note: 'a "quoted" [EMAIL_1]',
    });
    expect(JSON.parse(s.rehydrateArguments(args))).toEqual({
      fullName: 'Sara Ahmed',
      phone: PHONE,
      note: `a "quoted" ${EMAIL}`,
    });
  });

  it('leaves a token it never issued untouched', () => {
    const s = new MinimizationSession(history);
    expect(s.rehydrate('call [PHONE_9]')).toBe('call [PHONE_9]');
  });

  it('never restores a removed value', () => {
    const s = new MinimizationSession([
      { role: 'user', content: `ID ${NATIONAL_ID}` },
    ]);
    expect(s.rehydrate('[ID_REMOVED]')).toBe('[ID_REMOVED]');
  });

  it('survives a non-JSON arguments string', () => {
    const s = new MinimizationSession(history);
    expect(s.rehydrateArguments('phone=[PHONE_1]')).toBe(`phone=${PHONE}`);
  });

  it('round-trips: a minimised conversation rehydrates to the original facts', () => {
    const s = new MinimizationSession(history);
    const echoed = s.messages[0].content!;
    const restored = s.rehydrate(echoed);
    expect(restored).toContain(PHONE);
    expect(restored).toContain(EMAIL);
    expect(restored).toContain('Sara Ahmed');
  });
});

describe('streamRehydrator', () => {
  const session = () =>
    new MinimizationSession([
      { role: 'user', content: `${'0501234567'} and sara@example.com` },
    ]);

  it('restores a token split across deltas without leaking the fragment', () => {
    const r = session().streamRehydrator();
    const emitted: string[] = [];
    for (const d of ['Call ', '[PHO', 'NE_', '1] now']) emitted.push(r.push(d));
    emitted.push(r.flush());
    const joined = emitted.join('');
    expect(joined).toBe('Call 0501234567 now');
    expect(emitted.join('|')).not.toContain('[PHO');
  });

  it('passes ordinary brackets through, and flushes a dangling fragment', () => {
    const r = session().streamRehydrator();
    const out = [r.push('see [1] and [ok]'), r.push(' tail ['), r.flush()].join(
      '',
    );
    expect(out).toBe('see [1] and [ok] tail [');
  });

  it('does not hold back text that merely contains a long open bracket', () => {
    const r = session().streamRehydrator();
    const longTail = '[' + 'x'.repeat(40);
    expect(r.push(longTail)).toBe(longTail);
  });
});

describe('passthroughSession and scrubForEmbedding', () => {
  it('passthrough changes nothing', () => {
    const msgs: AiChatMessage[] = [{ role: 'user', content: `call ${PHONE}` }];
    const s = passthroughSession(msgs);
    expect(s.messages).toBe(msgs);
    expect(s.rehydrate('[PHONE_1]')).toBe('[PHONE_1]');
    expect(s.changed).toBe(false);
  });

  it('scrubForEmbedding removes identifiers irreversibly', () => {
    const out = scrubForEmbedding(
      `reach me on ${PHONE} / ${EMAIL}, ID ${NATIONAL_ID}`,
    );
    expect(out).toBe('reach me on [PHONE] / [EMAIL], ID [ID_REMOVED]');
  });
});
