import {
  assessSessionContent,
  assessTemplateContent,
  describeViolations,
  resolveContentPolicyMode,
} from './whatsapp-content-policy';
import type { WhatsappSessionPayload } from './providers/whatsapp-message.provider.interface';

const components = (text: string) => ({ components: [{ type: 'BODY', text }] });

const session = (
  overrides: Partial<WhatsappSessionPayload> = {},
): WhatsappSessionPayload => ({
  tenantId: 't1',
  accountId: 'a1',
  to: '966500000000',
  text: 'Your appointment is confirmed for 09:30.',
  ...overrides,
});

describe('resolveContentPolicyMode', () => {
  it('defaults to enforce and only accepts the three modes', () => {
    expect(resolveContentPolicyMode(undefined)).toBe('enforce');
    expect(resolveContentPolicyMode('monitor')).toBe('monitor');
    expect(resolveContentPolicyMode('OFF')).toBe('off');
    expect(resolveContentPolicyMode('nonsense')).toBe('enforce');
  });
});

describe('assessTemplateContent', () => {
  it('passes an ordinary appointment notice', () => {
    expect(
      assessTemplateContent(components('Hi {{1}}, see you on {{2}} at {{3}}'), {
        1: 'Sara',
        2: '2026-10-07',
        3: '09:30',
      }),
    ).toEqual([]);
  });

  it('reports the category and the variable name for an identifier in a variable', () => {
    const v = assessTemplateContent(components('Hi {{1}}, ref {{2}}'), {
      1: 'Sara',
      2: '1012345678',
    });
    expect(v).toContainEqual({
      category: 'national_id',
      variable: '2',
      scope: 'variable',
    });
    expect(describeViolations(v)).toContain('national_id in "2"');
    expect(describeViolations(v)).not.toContain('1012345678');
  });

  it('applies the clinical-term list to variables only, not to the approved body', () => {
    // Tenant-authored body text mentioning a term is not blocked by the word list...
    expect(
      assessTemplateContent(components('Your prescription is ready, {{1}}'), {
        1: 'Sara',
      }),
    ).toEqual([]);
    // ...but a variable carrying one is.
    expect(
      assessTemplateContent(components('Note: {{1}}'), {
        1: 'lab results attached',
      }),
    ).toContainEqual({
      category: 'clinical_term',
      variable: '1',
      scope: 'variable',
    });
  });

  it('still catches an identifier hard-coded in the body', () => {
    const v = assessTemplateContent(
      components('Your ID 1012345678 is on file'),
      {},
    );
    expect(v).toContainEqual({
      category: 'national_id',
      scope: 'rendered_body',
    });
  });

  it('does not double-report a category a variable already reported', () => {
    const v = assessTemplateContent(components('Ref {{1}}'), {
      1: '1012345678',
    });
    expect(v.filter((x) => x.category === 'national_id')).toHaveLength(1);
  });

  it('tolerates missing variables, null values and numbers', () => {
    expect(assessTemplateContent(components('Hi {{1}}'), undefined)).toEqual(
      [],
    );
    expect(
      assessTemplateContent(components('Hi {{1}}'), { 1: null, 2: 42 }),
    ).toEqual([]);
    expect(assessTemplateContent(undefined, { 1: 'x' })).toEqual([]);
  });
});

describe('assessSessionContent', () => {
  it('passes plain replies, including general talk about care', () => {
    expect(assessSessionContent(session())).toEqual([]);
    expect(
      assessSessionContent(
        session({
          text: 'We cannot give a diagnosis over chat; please book a visit.',
        }),
      ),
    ).toEqual([]);
  });

  it('flags an identifier in the body text', () => {
    expect(
      assessSessionContent(session({ text: 'Your ID is 1012345678' })),
    ).toEqual([{ category: 'national_id', scope: 'session' }]);
  });

  it('inspects header, footer, buttons and list rows too', () => {
    const hidden = '4111 1111 1111 1111';
    for (const interactive of [
      { header: `card ${hidden}`, buttons: [{ id: '1', title: 'ok' }] },
      { footer: `card ${hidden}`, buttons: [{ id: '1', title: 'ok' }] },
      { buttons: [{ id: '1', title: hidden }] },
      {
        list: {
          buttonText: 'Choose',
          sections: [
            {
              title: 's',
              rows: [{ id: '1', title: 'row', description: hidden }],
            },
          ],
        },
      },
    ]) {
      expect(assessSessionContent(session({ interactive }))).toContainEqual({
        category: 'card_number',
        scope: 'session',
      });
    }
  });
});
