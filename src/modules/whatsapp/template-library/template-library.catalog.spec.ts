import { validateTemplateAuthoring } from '../template-authoring.validator';
import { metaToAuthoringComponents } from '../template-components.util';
import { unboundPlaceholders } from '../template-readiness';
import {
  orderedBodyParameters,
  unsupportedTemplateShape,
  urlButtonParameters,
} from '../template-variables.util';
import {
  WHATSAPP_TEMPLATE_NAME_PATTERN,
  WHATSAPP_TEMPLATE_VARIABLE_SOURCES,
} from '../whatsapp.constants';
import {
  buildLibraryComponents,
  LibraryInstallValues,
  TEMPLATE_LIBRARY,
} from './template-library.catalog';

const FULL: LibraryInstallValues = {
  appUrl: 'https://app.ziyaratech.test',
  clinicPhone: '+966501234567',
  offerUrl: 'https://clinic.example.com/offers',
};

const env = (key: string) => {
  const def = TEMPLATE_LIBRARY.find((d) => d.key === key)!;
  const components = buildLibraryComponents(def, FULL);
  return {
    def,
    components,
    stored: { components, parameter_format: 'POSITIONAL' },
  };
};

describe('template library catalog', () => {
  it('ships exactly the six agreed templates, with stable unique keys and Meta-legal names', () => {
    expect(TEMPLATE_LIBRARY.map((t) => t.name)).toEqual([
      'appointment_confirmation_ar',
      'appointment_reminder_24h',
      'post_visit_followup_ar',
      'followup_booking_invitation_ar',
      'clinic_special_offer_ar',
      'patient_reengagement_ar',
    ]);
    expect(new Set(TEMPLATE_LIBRARY.map((t) => t.key)).size).toBe(6);
    expect(new Set(TEMPLATE_LIBRARY.map((t) => t.name)).size).toBe(6);
    for (const t of TEMPLATE_LIBRARY) {
      expect(t.name).toMatch(WHATSAPP_TEMPLATE_NAME_PATTERN);
      expect(t.language).toBe('ar');
      expect(t.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('proposes UTILITY only for the two transactional templates', () => {
    const byName = Object.fromEntries(
      TEMPLATE_LIBRARY.map((t) => [t.name, t.proposedCategory]),
    );
    expect(byName).toEqual({
      appointment_confirmation_ar: 'UTILITY',
      appointment_reminder_24h: 'UTILITY',
      post_visit_followup_ar: 'MARKETING',
      followup_booking_invitation_ar: 'MARKETING',
      clinic_special_offer_ar: 'MARKETING',
      patient_reengagement_ar: 'MARKETING',
    });
  });

  it.each(TEMPLATE_LIBRARY.map((t) => [t.key]))(
    '%s passes the pre-submission validator once install values are filled in',
    (key) => {
      const { stored } = env(key);
      const result = validateTemplateAuthoring({
        category: TEMPLATE_LIBRARY.find((t) => t.key === key)!.proposedCategory,
        components: metaToAuthoringComponents(stored),
      });
      expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(result.valid).toBe(true);
    },
  );

  it.each(TEMPLATE_LIBRARY.map((t) => [t.key]))(
    '%s is something this platform can send (shape check)',
    (key) => {
      expect(unsupportedTemplateShape(env(key).stored)).toBeUndefined();
    },
  );

  it.each(TEMPLATE_LIBRARY.map((t) => [t.key]))(
    '%s only binds placeholders it declares, to sources that exist',
    (key) => {
      const { def, stored } = env(key);
      const declared = [
        ...orderedBodyParameters(stored),
        ...urlButtonParameters(stored).map((p) => p.key),
      ];
      for (const [placeholder, source] of Object.entries(def.defaultMapping)) {
        expect(declared).toContain(placeholder);
        expect(WHATSAPP_TEMPLATE_VARIABLE_SOURCES).toContain(source);
      }
      expect(def.bodyExamples).toHaveLength(
        orderedBodyParameters(stored).length,
      );
    },
  );

  it('leaves the offer text and end date of the promotion for the clinic to write', () => {
    const { def, stored } = env('clinic_special_offer');
    expect(
      unboundPlaceholders({
        components: stored,
        variable_mapping: def.defaultMapping,
      }),
    ).toEqual(['3', '4']);
  });

  it('every other template is fully bound out of the box', () => {
    for (const def of TEMPLATE_LIBRARY.filter(
      (d) => d.key !== 'clinic_special_offer',
    )) {
      const { stored } = env(def.key);
      expect(
        unboundPlaceholders({
          components: stored,
          variable_mapping: def.defaultMapping,
        }),
      ).toEqual([]);
    }
  });

  it('the confirmation template carries a dynamic link button bound to the reschedule token, with a sample link', () => {
    const { stored, components } = env('appointment_confirmation');
    expect(urlButtonParameters(stored)).toEqual([
      { index: 0, key: 'button_0' },
    ]);
    const button = (components.find((c) => c.type === 'BUTTONS')!.buttons ??
      [])[0];
    expect(button.url).toBe(
      'https://app.ziyaratech.test/appointment-action/{{1}}',
    );
    expect(button.example?.[0]).toMatch(
      /^https:\/\/app\.ziyaratech\.test\/appointment-action\/\S+$/,
    );
  });

  it('keeps promotional wording out of the UTILITY templates', () => {
    const promo = /عرض|خصم|تخفيض|مجان|هدية|اشترك|offer|discount|sale|free/i;
    for (const def of TEMPLATE_LIBRARY.filter(
      (d) => d.proposedCategory === 'UTILITY',
    )) {
      expect(def.body).not.toMatch(promo);
      expect(def.footer ?? '').not.toMatch(promo);
      for (const b of def.buttons) expect(b.text).not.toMatch(promo);
    }
  });

  it('carries no real-looking personal data in the samples sent to Meta', () => {
    for (const def of TEMPLATE_LIBRARY) {
      for (const sample of def.bodyExamples) {
        expect(sample).not.toMatch(/\d{7,}/); // no phone / ID numbers
        expect(sample).not.toMatch(/@/);
      }
    }
  });

  it('every marketing template tells the patient how to stop (footer + stop button)', () => {
    for (const def of TEMPLATE_LIBRARY.filter(
      (d) => d.proposedCategory === 'MARKETING',
    )) {
      expect(def.footer).toContain('إيقاف');
      expect(
        def.buttons.some((b) => b.type === 'QUICK_REPLY' && b.text === 'إيقاف'),
      ).toBe(true);
    }
  });

  describe('install values that are not known yet', () => {
    it('leaves the phone out rather than inventing one — and the validator then blocks submission', () => {
      const def = TEMPLATE_LIBRARY.find(
        (d) => d.key === 'appointment_reminder_24h',
      )!;
      const components = buildLibraryComponents(def, {
        appUrl: 'https://app.test',
      });
      const phone = components.find((c) => c.type === 'BUTTONS')!.buttons![0];
      expect(phone.phone_number).toBeUndefined();

      const result = validateTemplateAuthoring({
        category: 'UTILITY',
        components: metaToAuthoringComponents({ components }),
      });
      expect(result.valid).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain(
        'BUTTON_PHONE_REQUIRED',
      );
    });

    it('leaves the offer link out until the clinic supplies it', () => {
      const def = TEMPLATE_LIBRARY.find(
        (d) => d.key === 'clinic_special_offer',
      )!;
      const components = buildLibraryComponents(def, {
        appUrl: 'https://app.test',
        clinicPhone: '+966501234567',
      });
      const result = validateTemplateAuthoring({
        category: 'MARKETING',
        components: metaToAuthoringComponents({ components }),
      });
      expect(result.valid).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain('BUTTON_URL_REQUIRED');
    });

    it('an http (non-https) app URL is refused by the validator, not silently submitted', () => {
      const def = TEMPLATE_LIBRARY.find(
        (d) => d.key === 'appointment_confirmation',
      )!;
      const components = buildLibraryComponents(def, {
        appUrl: 'http://localhost:3000',
        clinicPhone: '+966501234567',
      });
      const result = validateTemplateAuthoring({
        category: 'UTILITY',
        components: metaToAuthoringComponents({ components }),
      });
      expect(result.valid).toBe(false);
      expect(result.issues.map((i) => i.code)).toContain('BUTTON_URL_INVALID');
    });
  });
});
