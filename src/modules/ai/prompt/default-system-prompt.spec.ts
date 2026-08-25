import {
  DEFAULT_ASSISTANT_SYSTEM_PROMPT,
  DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
} from './default-system-prompt';

/**
 * Two properties of the platform system prompts that are decidable by reading,
 * and that silently break if nobody checks them.
 *
 * 1. THEY MUST FIT THE BUDGET. `AiPromptBudgetService.build()` truncates the
 *    system message at `AI_PROMPT_SYSTEM_TOKENS` and cuts from the END. An
 *    over-long prompt therefore does not degrade gracefully — it drops
 *    whatever guidance happens to be last, which for the public prompt is the
 *    entire FINDING A CLINIC section (the fix for the "no clinics available"
 *    dead end). Adding the clinical-safety block pushed the public prompt to
 *    2001 estimated tokens against a 2000 ceiling before it was tightened;
 *    without this test that would have shipped as a silent regression.
 *
 * 2. THE CLINICAL SAFETY BOUNDARY MUST BE PRESENT ON BOTH SURFACES. It lives
 *    in the shared core deliberately: a staff member relaying an AI-authored
 *    dose to a patient is the same harm as telling the patient directly.
 */

/** Mirrors `AiPromptBudgetService.estimate()` exactly — see its docstring. */
function estimate(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  const ascii = text.replace(/[^\x00-\x7F]/g, '');
  const asciiBytes = Buffer.byteLength(ascii, 'utf8');
  const nonAsciiBytes = Buffer.byteLength(text, 'utf8') - asciiBytes;
  return Math.max(1, Math.ceil(asciiBytes / 3 + nonAsciiBytes / 2));
}

/** `AI_PROMPT_SYSTEM_TOKENS`' default in `ai-prompt-budget.service.ts`. */
const SYSTEM_TOKEN_BUDGET = 2000;

/**
 * Headroom, so a one-line edit cannot land exactly on the ceiling. A failure
 * here means "make room", not "raise the budget" — the budget is shared with
 * every other block under `AI_PROMPT_MAX_INPUT_TOKENS`.
 */
const REQUIRED_HEADROOM_TOKENS = 100;

describe('default system prompts', () => {
  describe.each([
    ['public booking widget', DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT],
    ['staff assistant', DEFAULT_ASSISTANT_SYSTEM_PROMPT],
    ['whatsapp assistant', DEFAULT_WHATSAPP_SYSTEM_PROMPT],
  ])('%s', (_name, prompt) => {
    it('fits inside AI_PROMPT_SYSTEM_TOKENS with headroom (truncation cuts from the END)', () => {
      expect(estimate(prompt)).toBeLessThanOrEqual(
        SYSTEM_TOKEN_BUDGET - REQUIRED_HEADROOM_TOKENS,
      );
    });

    it('carries the clinical safety boundary', () => {
      expect(prompt).toContain('CLINICAL SAFETY');
      expect(prompt).toContain('You are not a clinician');
      expect(prompt).toContain('Never diagnose');
      expect(prompt).toContain('Never interpret a lab result');
      expect(prompt).toContain('URGENT SIGNS OVERRIDE EVERYTHING');
    });

    it('never tells the model that waiting is safe', () => {
      expect(prompt).toContain('Never say or imply that waiting is safe');
    });
  });

  describe('public booking widget only', () => {
    it('still carries the booking guidance that truncation would have eaten first', () => {
      // These are the LAST sections of the prompt, so they are exactly what a
      // budget overrun removes. Asserting them here is what makes the budget
      // test above meaningful rather than arithmetic for its own sake.
      expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toContain(
        'FINDING A CLINIC',
      );
      expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toContain(
        'ESTABLISHED BOOKING CONTEXT',
      );
      expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toContain('bookableClinics');
    });

    it('states that changing or cancelling a booking is not something it can do', () => {
      // The public toolset has no cancel/reschedule tool — `cancel_appointment`
      // and `reschedule_appointment` are staff-only and refuse without an
      // actor. Without this line the model was free to agree to do it.
      expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toContain(
        'You cannot change or cancel an existing appointment',
      );
      expect(DEFAULT_PUBLIC_BOOKING_SYSTEM_PROMPT).toContain(
        'request_human_handover',
      );
    });
  });

  it('the staff prompt does not advertise the public booking toolset', () => {
    // `availableTools()` hands `list_cities` to guests only; naming it here
    // would describe a tool the staff turn was never given.
    expect(DEFAULT_ASSISTANT_SYSTEM_PROMPT).not.toContain('list_cities');
  });

  describe('whatsapp assistant only', () => {
    it('does not advertise any tool the WHATSAPP channel is not given', () => {
      // `availableTools()`'s WHATSAPP branch excludes list_cities (guest-only)
      // and the cross-tenant discovery tools (search_clinics,
      // get_clinic_details, search_public_availability) — naming any of them
      // here would describe a tool this turn was never given.
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).not.toContain('list_cities');
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).not.toContain('search_clinics');
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).not.toContain(
        'get_clinic_details',
      );
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).not.toContain(
        'search_public_availability',
      );
    });

    it('states the single-clinic boundary and the own-clinic discovery order', () => {
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).toContain(
        'You represent ONLY this clinic',
      );
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).toContain(
        'list_clinic_branches',
      );
      expect(DEFAULT_WHATSAPP_SYSTEM_PROMPT).toContain('Never invent an id');
    });
  });
});
