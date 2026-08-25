import { WhatsappInboundAiService } from './whatsapp-inbound-ai.service';

/**
 * `buildInteractive` — renders the AI's last tool result as a tappable
 * WhatsApp list (see the method's own docblock). Had ZERO test coverage
 * before this file, including its three pre-existing cases
 * (`search_clinics` / `get_clinic_details` / `check_availability`); this
 * adds coverage for the three own-clinic discovery cases this feature adds
 * (`list_clinic_branches` / `list_clinic_doctors` / `list_clinic_services`)
 * plus the invariants every case shares.
 *
 * `buildInteractive`, `list`, `clip` and `serviceLine` are all pure — none
 * touch an injected dependency — so `Object.create(prototype)` is enough to
 * exercise them without constructing the full service (12 DI dependencies
 * that have nothing to do with this rendering logic).
 */
function buildInteractive(
  lastTool: { name: string; result: Record<string, unknown> } | undefined,
) {
  const service = Object.create(WhatsappInboundAiService.prototype) as {
    buildInteractive: (
      t: typeof lastTool,
    ) => { list?: { buttonText: string; sections: unknown[] } } | undefined;
  };
  return service.buildInteractive(lastTool);
}

describe('buildInteractive — no tool call / failed result', () => {
  it('returns undefined when there was no tool call this turn', () => {
    expect(buildInteractive(undefined)).toBeUndefined();
  });

  it('returns undefined when the tool call failed', () => {
    expect(
      buildInteractive({
        name: 'list_clinic_branches',
        result: { success: false, error: 'boom' },
      }),
    ).toBeUndefined();
  });

  it('returns undefined for a tool with no interactive rendering', () => {
    expect(
      buildInteractive({ name: 'book_appointment', result: { success: true } }),
    ).toBeUndefined();
  });
});

describe('buildInteractive — list_clinic_branches', () => {
  it('renders a tappable list with the address as description, and no UUID in any visible text', () => {
    const BRANCH_ID = '11111111-1111-4111-8111-111111111111';
    const result = buildInteractive({
      name: 'list_clinic_branches',
      result: {
        success: true,
        branches: [
          { id: BRANCH_ID, name: 'Main Branch', address: '123 Main St' },
        ],
      },
    });

    expect(result?.list?.buttonText).toBe('Choose a branch');
    const rows = result?.list?.sections[0] as {
      title: string;
      rows: { id: string; title: string; description?: string }[];
    };
    expect(rows.rows).toEqual([
      { id: BRANCH_ID, title: 'Main Branch', description: '123 Main St' },
    ]);
    // The id (a raw UUID) travels only in the machine-readable `id` field —
    // WhatsApp never renders it — never in `title` or `description`.
    expect(rows.rows[0].title).not.toContain(BRANCH_ID);
    expect(rows.rows[0].description).not.toContain(BRANCH_ID);
  });

  it('returns undefined (not an empty list) when the clinic has no active branches', () => {
    expect(
      buildInteractive({
        name: 'list_clinic_branches',
        result: { success: true, count: 0, branches: [] },
      }),
    ).toBeUndefined();
  });

  it('caps at 10 rows when the clinic has more branches than a WhatsApp list can show', () => {
    const branches = Array.from({ length: 15 }, (_, i) => ({
      id: `branch-${i}`,
      name: `Branch ${i}`,
      address: 'Somewhere',
    }));
    const result = buildInteractive({
      name: 'list_clinic_branches',
      result: { success: true, branches },
    });
    const rows = (
      result?.list?.sections[0] as { rows: unknown[] }
    ).rows;
    expect(rows).toHaveLength(10);
    // The cap is on the INTERACTIVE affordance only — the model's own text
    // reply (sent alongside `interactive`, never replaced by it — see
    // `sendReply`) is what carries the rest of the list to the patient.
  });
});

describe('buildInteractive — list_clinic_doctors', () => {
  it('renders doctors with their title as description', () => {
    const result = buildInteractive({
      name: 'list_clinic_doctors',
      result: {
        success: true,
        doctors: [{ id: 'doc-1', name: 'Dr. Amina', title: 'Dermatologist' }],
      },
    });
    expect(result?.list?.buttonText).toBe('Choose a doctor');
    const rows = (
      result?.list?.sections[0] as {
        rows: { id: string; title: string; description?: string }[];
      }
    ).rows;
    expect(rows).toEqual([
      { id: 'doc-1', title: 'Dr. Amina', description: 'Dermatologist' },
    ]);
  });

  it('omits the description when the doctor has no title, without dropping the row', () => {
    const result = buildInteractive({
      name: 'list_clinic_doctors',
      result: { success: true, doctors: [{ id: 'doc-2', name: 'Dr. Sara' }] },
    });
    const rows = (
      result?.list?.sections[0] as {
        rows: { id: string; title: string; description?: string }[];
      }
    ).rows;
    expect(rows).toEqual([
      { id: 'doc-2', title: 'Dr. Sara', description: undefined },
    ]);
  });
});

describe('buildInteractive — list_clinic_services', () => {
  it('renders services with price and duration as description', () => {
    const result = buildInteractive({
      name: 'list_clinic_services',
      result: {
        success: true,
        services: [
          {
            id: 'svc-1',
            name: 'Dermatology Consult',
            price: 250,
            durationMinutes: 30,
            pricingType: 'FIXED',
          },
        ],
      },
    });
    const rows = (
      result?.list?.sections[0] as {
        rows: { id: string; title: string; description?: string }[];
      }
    ).rows;
    expect(rows[0].title).toBe('Dermatology Consult');
    expect(rows[0].description).toBe('250 · 30 min');
  });

  it('omits the description (not the row) when a service has neither price nor duration on file', () => {
    const result = buildInteractive({
      name: 'list_clinic_services',
      result: {
        success: true,
        services: [{ id: 'svc-2', name: 'Consult', price: null }],
      },
    });
    const rows = (
      result?.list?.sections[0] as {
        rows: { id: string; title: string; description?: string }[];
      }
    ).rows;
    expect(rows).toEqual([
      { id: 'svc-2', title: 'Consult', description: undefined },
    ]);
  });
});
