import { ConfigService } from '@nestjs/config';

import { OpenAiChatProvider } from './openai-chat.provider';
import type { AiChatMessage } from './ai-provider.interface';

/**
 * Residency plan P2 evidence: what the provider actually puts on the wire.
 *
 * A recording client stands in for the OpenAI SDK, so every assertion is about
 * the request body that would have left the process — not about the minimiser
 * in isolation. One fixture carries every prohibited category.
 */

const PHONE = '0501234567';
const EMAIL = 'sara.ahmed@example.com';
const NATIONAL_ID = '1012345678';
const EGYPT_ID = '29801011234567';
const CARD = '4111111111111111';
const NAME = 'Sara Ahmed';
const DOB = '1990-01-01';

const history: AiChatMessage[] = [
  {
    role: 'system',
    // A clinic's own public number: it is tokenised too, and restored if the model repeats it.
    content: 'You are the clinic assistant. Reception line is 0112345678.',
  },
  {
    role: 'user',
    content: `I am ${NAME}. Phone ${PHONE}, email ${EMAIL}, ID ${NATIONAL_ID}, other ID ${EGYPT_ID}, card ${CARD}.`,
  },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        name: 'book_public_appointment',
        arguments: JSON.stringify({ fullName: NAME, phone: PHONE }),
      },
    ],
  },
  {
    role: 'tool',
    tool_call_id: 'call_1',
    content: JSON.stringify({
      ok: true,
      patient_name: NAME,
      national_id: NATIONAL_ID,
      dateOfBirth: DOB,
    }),
  },
];

const PROHIBITED = [
  PHONE,
  EMAIL,
  NATIONAL_ID,
  EGYPT_ID,
  CARD,
  'Sara',
  'Ahmed',
  DOB,
];

interface SentBody {
  messages: Array<{ content?: string }>;
}

/** Reads the token the minimiser issued for the thing that followed `label` in the user turn. */
function tokenAfter(
  body: SentBody,
  label: string,
  kind: 'PHONE' | 'NAME' | 'EMAIL',
): string {
  const userTurn = String(body.messages[1].content);
  const tail = userTurn.slice(userTurn.indexOf(label));
  return tail.match(new RegExp(`\\[${kind}_\\d+\\]`))![0];
}

function build(config: Record<string, unknown> = {}) {
  const provider = new OpenAiChatProvider(
    new ConfigService({ OPENAI_API_KEY: 'k', ...config }),
  );
  const create = jest.fn();
  (provider as any).client = { chat: { completions: { create } } };
  return {
    provider,
    create,
    sent: () => JSON.stringify(create.mock.calls[0][0]),
  };
}

describe('OpenAiChatProvider — outbound minimisation (residency plan P2)', () => {
  it('sends no prohibited identifier in a non-streaming request body', async () => {
    const { provider, create, sent } = build();
    create.mockResolvedValue({
      model: 'gpt-5.6-luna',
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await provider.complete({ tenantId: 't1', messages: history });

    const body = sent();
    for (const secret of PROHIBITED) expect(body).not.toContain(secret);
    expect(body).toContain('[NAME_');
    expect(body).toContain('[PHONE_');
    expect(body).toContain('[EMAIL_');
  });

  it('restores real values in the reply and in tool-call arguments', async () => {
    const { provider, create } = build();
    create.mockImplementation(async (body: SentBody) => {
      const phoneTok = tokenAfter(body, 'Phone ', 'PHONE');
      const nameTok = tokenAfter(body, 'I am ', 'NAME');
      return {
        model: 'gpt-5.6-luna',
        choices: [
          {
            message: {
              content: `Thanks ${nameTok}, we will call ${phoneTok}.`,
              tool_calls: [
                {
                  type: 'function',
                  id: 'call_2',
                  function: {
                    name: 'book_public_appointment',
                    arguments: JSON.stringify({
                      fullName: nameTok,
                      phone: phoneTok,
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
    });

    const result = await provider.complete({
      tenantId: 't1',
      messages: history,
    });
    expect(result.content).toBe(`Thanks ${NAME}, we will call ${PHONE}.`);
    expect(JSON.parse(result.toolCalls![0].arguments)).toEqual({
      fullName: NAME,
      phone: PHONE,
    });
  });

  it('streams a reply whose token is split across chunks and restores it', async () => {
    const { provider, create, sent } = build();
    const chunk = (content?: string, extra: Record<string, unknown> = {}) => ({
      model: 'gpt-5.6-luna',
      choices: [{ delta: content === undefined ? {} : { content } }],
      ...extra,
    });
    create.mockImplementation(async (body: SentBody) => {
      const tok = tokenAfter(body, 'Phone ', 'PHONE'); // e.g. "[PHONE_2]"
      const cut = 4; // "[PHO" | "NE_2]"
      return (async function* () {
        yield chunk('Calling ');
        yield chunk(tok.slice(0, cut));
        yield chunk(tok.slice(cut));
        yield chunk(' now');
        yield chunk(undefined, {
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      })();
    });

    const deltas: string[] = [];
    let done = false;
    for await (const c of provider.stream!({
      tenantId: 't1',
      messages: history,
    })) {
      if (c.delta) deltas.push(c.delta);
      if (c.done) done = true;
    }

    expect(done).toBe(true);
    expect(deltas.join('')).toBe(`Calling ${PHONE} now`);
    expect(deltas.some((d) => d.includes('[PHO'))).toBe(false);
    for (const secret of PROHIBITED) expect(sent()).not.toContain(secret);
  });

  it('restores tool-call arguments assembled from a stream', async () => {
    const { provider, create } = build();
    create.mockImplementation(async (body: SentBody) => {
      const tok = tokenAfter(body, 'Phone ', 'PHONE');
      const json = JSON.stringify({ phone: tok });
      const cut = json.indexOf('[PHO') + 4;
      return (async function* () {
        yield {
          model: 'm',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c9',
                    function: {
                      name: 'book_public_appointment',
                      arguments: json.slice(0, cut),
                    },
                  },
                ],
              },
            },
          ],
        };
        yield {
          model: 'm',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: json.slice(cut) } },
                ],
              },
            },
          ],
        };
      })();
    });

    let calls: Array<{ arguments: string }> | undefined;
    for await (const c of provider.stream!({
      tenantId: 't1',
      messages: history,
    })) {
      if (c.done) calls = c.toolCalls;
    }
    expect(JSON.parse(calls![0].arguments)).toEqual({ phone: PHONE });
  });

  it('sends the request unchanged when the kill-switch is off', async () => {
    const { provider, create, sent } = build({ AI_MINIMIZER_ENABLED: 'false' });
    create.mockResolvedValue({
      model: 'm',
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await provider.complete({ tenantId: 't1', messages: history });
    expect(sent()).toContain(PHONE);
  });

  it('refuses the request rather than sending it raw if the minimiser itself fails', async () => {
    const { provider, create } = build();
    const hostile = [
      {
        role: 'user',
        get content(): string {
          throw new Error('boom');
        },
      },
    ] as unknown as AiChatMessage[];
    await expect(
      provider.complete({ tenantId: 't1', messages: hostile }),
    ).rejects.toThrow('boom');
    expect(create).not.toHaveBeenCalled();
  });
});
