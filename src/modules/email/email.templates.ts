/**
 * Transactional email templates (HTML + plain-text) as code.
 *
 * Each template is a pure renderer `(vars, ctx) => { subject, html, text }`, so
 * they are trivially unit-testable and localizable. Interpolated user values are
 * HTML-escaped to prevent injection in the rendered HTML. `ctx.locale` is
 * threaded through for future multilingual variants (English is the base).
 */

export type EmailTemplateKey =
  | 'welcome'
  | 'email_verification'
  | 'password_reset'
  | 'appointment_confirmation'
  | 'appointment_reminder'
  | 'appointment_cancelled'
  | 'appointment_rescheduled'
  | 'subscription_invoice'
  | 'payment_failed'
  | 'payment_success'
  | 'trial_ending'
  | 'subscription_activated'
  | 'subscription_renewed'
  | 'subscription_cancelled'
  | 'subscription_expiring_soon'
  | 'subscription_entered_grace'
  | 'subscription_grace_ending_soon'
  | 'staff_invitation'
  | 'security_alert'
  | 'doctor_notification'
  | 'patient_notification'
  | 'generic';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}
export type EmailVars = Record<string, unknown>;
export interface RenderContext {
  appUrl: string;
  locale: string;
  brand?: string;
}

const s = (v: unknown, fallback = ''): string => (v == null ? fallback : String(v));
const esc = (v: unknown): string =>
  s(v).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function layout(title: string, body: string, ctx: RenderContext): string {
  const brand = esc(ctx.brand ?? 'Ziyarati');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2a37">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e9f0">
<tr><td style="background:#0f766e;padding:20px 28px"><span style="color:#fff;font-size:18px;font-weight:700">${brand}</span></td></tr>
<tr><td style="padding:28px">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#fafbfc;border-top:1px solid #eef1f5;color:#8a97a8;font-size:12px">
You are receiving this email from ${brand}. If this wasn't you, you can ignore it.
</td></tr></table></td></tr></table></body></html>`;
}

const btn = (label: string, url: string): string =>
  `<a href="${esc(url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">${esc(label)}</a>`;
const p = (html: string): string => `<p style="margin:0 0 14px;line-height:1.6">${html}</p>`;
const h = (t: string): string => `<h1 style="margin:0 0 16px;font-size:20px">${esc(t)}</h1>`;

/** Standard action email: heading + intro + button + fallback link. */
function action(
  title: string,
  greeting: string,
  intro: string,
  cta: { label: string; url: string } | null,
  outro: string,
  ctx: RenderContext,
): RenderedEmail {
  const body =
    h(title) +
    p(esc(greeting)) +
    p(esc(intro)) +
    (cta ? `<p style="margin:20px 0">${btn(cta.label, cta.url)}</p>` +
      p(`<span style="color:#8a97a8;font-size:13px">Or paste this link: ${esc(cta.url)}</span>`) : '') +
    (outro ? p(esc(outro)) : '');
  const text = [title, '', greeting, intro, cta ? `${cta.label}: ${cta.url}` : '', outro]
    .filter(Boolean)
    .join('\n');
  return { subject: title, html: layout(title, body, ctx), text };
}

const name = (v: EmailVars): string => s(v.name, 'there');

export const EMAIL_TEMPLATES: Record<EmailTemplateKey, (v: EmailVars, ctx: RenderContext) => RenderedEmail> = {
  welcome: (v, ctx) =>
    action('Welcome to ' + s(ctx.brand ?? 'Ziyarati'), `Hi ${name(v)},`,
      `Your clinic "${s(v.clinicName, 'account')}" is set up. Let's get you started.`,
      { label: 'Open dashboard', url: `${ctx.appUrl}/app/dashboard` },
      'We\'re glad to have you on board.', ctx),

  email_verification: (v, ctx) =>
    action('Verify your email', `Hi ${name(v)},`,
      'Please confirm your email address to activate your account.',
      { label: 'Verify email', url: s(v.verifyUrl) }, 'This link expires soon.', ctx),

  password_reset: (v, ctx) =>
    action('Reset your password', `Hi ${name(v)},`,
      'We received a request to reset your password. If you made this request, click below.',
      { label: 'Reset password', url: s(v.resetUrl) },
      'If you didn\'t request this, no action is needed — your password is unchanged.', ctx),

  appointment_confirmation: (v, ctx) =>
    action('Appointment confirmed', `Hi ${name(v)},`,
      `Your appointment${v.service ? ` for ${s(v.service)}` : ''} is confirmed for ${s(v.dateTime)}${v.clinicName ? ` at ${s(v.clinicName)}` : ''}.`,
      v.detailsUrl ? { label: 'View appointment', url: s(v.detailsUrl) } : null,
      'Please arrive a few minutes early.', ctx),

  appointment_reminder: (v, ctx) =>
    action('Appointment reminder', `Hi ${name(v)},`,
      `This is a reminder of your appointment${v.service ? ` for ${s(v.service)}` : ''} on ${s(v.dateTime)}${v.clinicName ? ` at ${s(v.clinicName)}` : ''}.`,
      v.detailsUrl ? { label: 'View appointment', url: s(v.detailsUrl) } : null, '', ctx),

  appointment_cancelled: (v, ctx) =>
    action('Appointment cancelled', `Hi ${name(v)},`,
      `Your appointment on ${s(v.dateTime)} has been cancelled${v.reason ? `: ${s(v.reason)}` : '.'}`,
      v.rebookUrl ? { label: 'Book again', url: s(v.rebookUrl) } : null, '', ctx),

  appointment_rescheduled: (v, ctx) =>
    action('Appointment rescheduled', `Hi ${name(v)},`,
      `Your appointment has been moved to ${s(v.dateTime)}.`,
      v.detailsUrl ? { label: 'View appointment', url: s(v.detailsUrl) } : null, '', ctx),

  subscription_invoice: (v, ctx) =>
    action('Your invoice', `Hi ${name(v)},`,
      `Invoice ${s(v.invoiceNumber, '')} for ${s(v.amount)} is available for your ${s(v.planName, 'subscription')} plan.`,
      v.invoiceUrl ? { label: 'View invoice', url: s(v.invoiceUrl) } : { label: 'View billing', url: `${ctx.appUrl}/app/billing` },
      '', ctx),

  payment_success: (v, ctx) =>
    action('Payment received', `Hi ${name(v)},`,
      `We received your payment of ${s(v.amount)}. Thank you!`,
      v.receiptUrl ? { label: 'View receipt', url: s(v.receiptUrl) } : null, '', ctx),

  payment_failed: (v, ctx) =>
    action('Payment failed', `Hi ${name(v)},`,
      `We couldn't process your payment of ${s(v.amount)}${v.reason ? ` (${s(v.reason)})` : ''}. Please update your payment method to avoid interruption.`,
      { label: 'Update payment', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  trial_ending: (v, ctx) =>
    action('Your trial is ending', `Hi ${name(v)},`,
      `Your free trial ends in ${s(v.daysLeft, 'a few')} day(s). Upgrade now to keep access to all features.`,
      { label: 'Choose a plan', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  subscription_activated: (v, ctx) =>
    action('Subscription activated', `Hi ${name(v)},`,
      `Your ${s(v.planName, '')} subscription is now active.`,
      { label: 'Go to dashboard', url: `${ctx.appUrl}/app/dashboard` }, '', ctx),

  subscription_renewed: (v, ctx) =>
    action('Subscription renewed', `Hi ${name(v)},`,
      `Your ${s(v.planName, '')} subscription renewed successfully${v.nextRenewal ? ` until ${s(v.nextRenewal)}` : ''}.`,
      null, '', ctx),

  subscription_cancelled: (v, ctx) =>
    action('Subscription cancelled', `Hi ${name(v)},`,
      `Your subscription has been cancelled${v.endsAt ? ` and access continues until ${s(v.endsAt)}` : ''}.`,
      { label: 'Reactivate', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  // FND-031 — the three grace-lifecycle notification points (before expiry,
  // at expiry, before grace end). No automatic re-billing is implied or
  // performed by any of these — informational only.
  subscription_expiring_soon: (v, ctx) =>
    action('Your subscription is ending soon', `Hi ${name(v)},`,
      `Your ${s(v.planName, '')} subscription ends on ${s(v.endsAt)}. Renew to avoid any interruption.`,
      { label: 'Manage subscription', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  subscription_entered_grace: (v, ctx) =>
    action('Your subscription has ended — grace period active', `Hi ${name(v)},`,
      `Your ${s(v.planName, '')} subscription ended on ${s(v.endsAt)}. You keep full access until ${s(v.graceEndsAt)} while you renew — nothing has been charged automatically.`,
      { label: 'Renew now', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  subscription_grace_ending_soon: (v, ctx) =>
    action('Your grace period is ending soon', `Hi ${name(v)},`,
      `Your grace period ends on ${s(v.graceEndsAt)}. After that, new billable actions will be paused until you renew — your existing data stays fully accessible.`,
      { label: 'Renew now', url: `${ctx.appUrl}/app/billing` }, '', ctx),

  staff_invitation: (v, ctx) =>
    action('You\'ve been invited', `Hi ${name(v)},`,
      `${s(v.inviterName, 'A clinic admin')} invited you to join ${s(v.clinicName, 'their clinic')}${v.role ? ` as ${s(v.role)}` : ''}.`,
      { label: 'Accept invitation', url: s(v.invitationUrl) }, 'This invitation may expire.', ctx),

  security_alert: (v, ctx) =>
    action('Security alert', `Hi ${name(v)},`,
      s(v.message, 'We detected an important security event on your account.'),
      v.actionUrl ? { label: 'Review activity', url: s(v.actionUrl) } : null,
      'If this was you, no action is needed.', ctx),

  doctor_notification: (v, ctx) =>
    action(s(v.title, 'Notification'), `Hi Dr. ${name(v)},`, s(v.message),
      v.actionUrl ? { label: s(v.actionLabel, 'View'), url: s(v.actionUrl) } : null, '', ctx),

  patient_notification: (v, ctx) =>
    action(s(v.title, 'Notification'), `Hi ${name(v)},`, s(v.message),
      v.actionUrl ? { label: s(v.actionLabel, 'View'), url: s(v.actionUrl) } : null, '', ctx),

  generic: (v, ctx) =>
    action(s(v.title, 'Notification'), `Hi ${name(v)},`, s(v.message),
      v.actionUrl ? { label: s(v.actionLabel, 'Open'), url: s(v.actionUrl) } : null, '', ctx),
};

export function renderEmail(
  key: string,
  vars: EmailVars,
  ctx: RenderContext,
): RenderedEmail {
  const renderer = EMAIL_TEMPLATES[key as EmailTemplateKey] ?? EMAIL_TEMPLATES.generic;
  return renderer(vars, ctx);
}
