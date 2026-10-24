import type { MetaTemplateComponentInput } from '../meta/meta-graph.client';
import { WHATSAPP_TEMPLATE_VARIABLE_SOURCE as SRC } from '../whatsapp.constants';

/**
 * The ready-made WhatsApp templates every clinic can adopt.
 *
 * This is a VERSIONED CATALOG IN CODE, not rows in a table: it is identical for
 * every tenant, reviewed in git, and carries nothing a clinic owns. A clinic's
 * copy is a separate `whatsapp_templates` row created by an explicit "adopt"
 * (see `WhatsappTemplateLibraryService`) — so there is no per-tenant seeding to
 * duplicate, nothing is ever sent to Meta on adoption, and raising `version`
 * here OFFERS an update without touching what a clinic already edited.
 *
 * Rules that apply to every entry:
 *  - Arabic (`ar`), positional `{{1}}…{{n}}` placeholders.
 *  - The category is a PROPOSAL. Meta decides the final one; everything
 *    downstream (consent gating, UI) follows the category Meta reports back.
 *  - No promotional wording in a UTILITY template.
 *  - Examples submitted to Meta are fictional — never a real patient or clinic.
 *  - Nothing clinical is bound to a placeholder (see `WHATSAPP_TEMPLATE_VARIABLE_SOURCE`).
 *
 * Install-time values are filled when a clinic adopts an entry: `__APP_URL__`
 * (the app's public base URL), the clinic's phone for call buttons, and the
 * clinic's own offer link where an entry needs one.
 */
export const APP_URL_TOKEN = '__APP_URL__';

export type LibraryCategory = 'UTILITY' | 'MARKETING';

export interface LibraryButtonDef {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER';
  text: string;
  /** URL button: may contain `__APP_URL__`. Omitted = the clinic must supply it. */
  url?: string;
  /** URL button ending in `{{1}}`: a complete sample link for Meta. */
  urlExample?: string;
  /** Which install-time value fills this button. */
  fill?: 'clinic_phone' | 'offer_url';
}

export interface LibraryTemplateDef {
  /** Stable identifier — never changes once shipped. */
  key: string;
  /** Bumped whenever the copy / structure changes. */
  version: number;
  /** Meta template name (lower-case, digits, underscores). */
  name: string;
  language: 'ar';
  proposedCategory: LibraryCategory;
  /** i18n key (frontend) for the one-line purpose shown on the card. */
  purposeKey: string;
  body: string;
  /** One fictional sample per body placeholder, in order. */
  bodyExamples: string[];
  footer?: string;
  buttons: LibraryButtonDef[];
  /** Default placeholder → trusted data source. A missing key means "the clinic must choose". */
  defaultMapping: Record<string, string>;
  /** Why this proposed category — shown to the owner. */
  categoryRationale:
    | 'transactional'
    | 'invites_rebooking'
    | 'promotional'
    | 'winback';
}

const OPT_OUT_FOOTER = 'للإيقاف أرسل: إيقاف';
const STOP_BUTTON: LibraryButtonDef = { type: 'QUICK_REPLY', text: 'إيقاف' };
const CALL_BUTTON: LibraryButtonDef = {
  type: 'PHONE_NUMBER',
  text: 'اتصل بالعيادة',
  fill: 'clinic_phone',
};

const APPOINTMENT_MAPPING = {
  '1': SRC.PATIENT_FIRST_NAME,
  '2': SRC.CLINIC_NAME,
  '3': SRC.APPOINTMENT_DATE,
  '4': SRC.APPOINTMENT_TIME,
} as const;

const NAME_CLINIC_MAPPING = {
  '1': SRC.PATIENT_FIRST_NAME,
  '2': SRC.CLINIC_NAME,
} as const;

export const TEMPLATE_LIBRARY: readonly LibraryTemplateDef[] = [
  {
    key: 'appointment_confirmation',
    version: 1,
    name: 'appointment_confirmation_ar',
    language: 'ar',
    proposedCategory: 'UTILITY',
    purposeKey: 'appointmentConfirmation',
    categoryRationale: 'transactional',
    body:
      'مرحباً {{1}}، تم تأكيد موعدك في {{2}}.\n' +
      'التاريخ: {{3}}\n' +
      'الوقت: {{4}}\n' +
      'لتغيير موعدك استخدم الزر أدناه أو تواصل مع العيادة.',
    bodyExamples: ['سارة', 'عيادة الأمل', 'الأحد، 12 أكتوبر 2026', '5:30 م'],
    buttons: [
      {
        type: 'URL',
        text: 'تغيير الموعد',
        url: `${APP_URL_TOKEN}/appointment-action/{{1}}`,
        urlExample: `${APP_URL_TOKEN}/appointment-action/Ab3dEfGh1jKlMnOpQrStUvWxYz0123456789_-aBcD`,
      },
    ],
    defaultMapping: { ...APPOINTMENT_MAPPING, button_0: SRC.RESCHEDULE_TOKEN },
  },
  {
    key: 'appointment_reminder_24h',
    version: 1,
    name: 'appointment_reminder_24h',
    language: 'ar',
    proposedCategory: 'UTILITY',
    purposeKey: 'appointmentReminder24h',
    categoryRationale: 'transactional',
    body:
      'مرحباً {{1}}، نذكّرك بموعدك في {{2}} غداً {{3}} الساعة {{4}}.\n' +
      'إذا احتجت إلى تغيير الموعد، يرجى التواصل مع العيادة.',
    bodyExamples: ['سارة', 'عيادة الأمل', 'الأحد، 12 أكتوبر 2026', '5:30 م'],
    buttons: [CALL_BUTTON],
    defaultMapping: { ...APPOINTMENT_MAPPING },
  },
  {
    key: 'post_visit_followup',
    version: 1,
    name: 'post_visit_followup_ar',
    language: 'ar',
    proposedCategory: 'MARKETING',
    purposeKey: 'postVisitFollowup',
    // The message invites the patient to book another visit. Meta classifies a
    // message that encourages further purchase/booking as MARKETING, so that is
    // what is proposed; the owner can reword it as a plain service message.
    categoryRationale: 'invites_rebooking',
    body:
      'مرحباً {{1}}، شكراً لزيارتك {{2}}.\n' +
      'إذا احتجت إلى أي مساعدة بخصوص موعدك أو رغبت في حجز زيارة أخرى، يسعد فريق العيادة مساعدتك.',
    bodyExamples: ['سارة', 'عيادة الأمل'],
    footer: OPT_OUT_FOOTER,
    buttons: [STOP_BUTTON, CALL_BUTTON],
    defaultMapping: { ...NAME_CLINIC_MAPPING },
  },
  {
    key: 'followup_booking_invitation',
    version: 1,
    name: 'followup_booking_invitation_ar',
    language: 'ar',
    proposedCategory: 'MARKETING',
    purposeKey: 'followupBookingInvitation',
    categoryRationale: 'invites_rebooking',
    body:
      'مرحباً {{1}}، إذا رغبت في حجز موعد متابعة لدى {{2}}، يسعدنا مساعدتك في اختيار الوقت المناسب.\n' +
      'اضغط على الزر أدناه للتواصل مع فريق العيادة.',
    bodyExamples: ['سارة', 'عيادة الأمل'],
    footer: OPT_OUT_FOOTER,
    buttons: [STOP_BUTTON, CALL_BUTTON],
    defaultMapping: { ...NAME_CLINIC_MAPPING },
  },
  {
    key: 'clinic_special_offer',
    version: 1,
    name: 'clinic_special_offer_ar',
    language: 'ar',
    proposedCategory: 'MARKETING',
    purposeKey: 'clinicSpecialOffer',
    categoryRationale: 'promotional',
    body:
      'مرحباً {{1}}، يقدّم {{2}} عرضاً خاصاً على {{3}} حتى {{4}}.\n' +
      'للتفاصيل والشروط، اضغط على الزر أدناه.',
    bodyExamples: ['سارة', 'عيادة الأمل', 'الكشف الأول', '31 أكتوبر'],
    footer: OPT_OUT_FOOTER,
    buttons: [
      STOP_BUTTON,
      { type: 'URL', text: 'تفاصيل العرض', fill: 'offer_url' },
    ],
    // {{3}} (the offer) and {{4}} (its end date) are the clinic's to write: they
    // are deliberately NOT pre-bound, so the template cannot be switched on with
    // placeholder text.
    defaultMapping: { ...NAME_CLINIC_MAPPING },
  },
  {
    key: 'patient_reengagement',
    version: 1,
    name: 'patient_reengagement_ar',
    language: 'ar',
    proposedCategory: 'MARKETING',
    purposeKey: 'patientReengagement',
    categoryRationale: 'winback',
    body:
      'مرحباً {{1}}، يتطلع فريق {{2}} لخدمتك مرة أخرى.\n' +
      'إذا رغبت في حجز موعد جديد أو كان لديك أي استفسار عن خدمات العيادة، تواصل معنا عبر الزر أدناه.',
    bodyExamples: ['سارة', 'عيادة الأمل'],
    footer: OPT_OUT_FOOTER,
    buttons: [STOP_BUTTON, CALL_BUTTON],
    defaultMapping: { ...NAME_CLINIC_MAPPING },
  },
];

export function findLibraryTemplate(
  key: string,
): LibraryTemplateDef | undefined {
  return TEMPLATE_LIBRARY.find((t) => t.key === key);
}

export interface LibraryInstallValues {
  /** The app's public base URL (no trailing slash). */
  appUrl: string;
  /** Normalised E.164 clinic phone, or `undefined` if the clinic has none yet. */
  clinicPhone?: string;
  /** The clinic's own offer link (promotional template). */
  offerUrl?: string;
}

/**
 * Catalog entry → the Meta-shaped components stored on the draft.
 *
 * Deliberately lenient about install-time values that are not known yet (a
 * clinic with no phone on file, an offer link not typed): the field is simply
 * left out, the draft is saved, and the pre-submission validator then refuses
 * to SUBMIT it until the clinic fills it in — a blank is never sent to Meta.
 */
export function buildLibraryComponents(
  def: LibraryTemplateDef,
  values: LibraryInstallValues,
): MetaTemplateComponentInput[] {
  const withBase = (s: string | undefined) =>
    s?.split(APP_URL_TOKEN).join(values.appUrl);

  const components: MetaTemplateComponentInput[] = [
    {
      type: 'BODY',
      text: def.body,
      example: { body_text: [def.bodyExamples] },
    },
  ];
  if (def.footer) components.push({ type: 'FOOTER', text: def.footer });

  if (def.buttons.length > 0) {
    components.push({
      type: 'BUTTONS',
      buttons: def.buttons.map((b) => {
        if (b.type === 'PHONE_NUMBER') {
          return {
            type: 'PHONE_NUMBER' as const,
            text: b.text,
            ...(values.clinicPhone ? { phone_number: values.clinicPhone } : {}),
          };
        }
        if (b.type === 'URL') {
          const url =
            b.fill === 'offer_url' ? values.offerUrl : withBase(b.url);
          return {
            type: 'URL' as const,
            text: b.text,
            ...(url ? { url } : {}),
            ...(b.urlExample
              ? { example: [withBase(b.urlExample) as string] }
              : {}),
          };
        }
        return { type: 'QUICK_REPLY' as const, text: b.text };
      }),
    });
  }
  return components;
}
