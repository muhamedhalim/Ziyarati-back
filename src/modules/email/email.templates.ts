/**
 * Transactional email templates (HTML + plain-text) as code.
 *
 * Each template is a pure renderer `(vars, ctx) => { subject, html, text }`, so
 * they are trivially unit-testable and localizable. Interpolated user values are
 * HTML-escaped to prevent injection in the rendered HTML. `ctx.locale` selects
 * between the English and Arabic copy via the `t()` helper below (T155/LR-003 —
 * this is the ONLY locale mechanism; `ctx.locale` already threads in from
 * `EmailSendJob.locale` via `EmailDeliveryService`, unchanged).
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
  | 'staff_credentials'
  | 'security_alert'
  | 'doctor_notification'
  | 'patient_notification'
  | 'generic'
  // Phase 11 (US7, T132) — marketing family, deliberately separate from every
  // transactional key above: clinic-authored content + an unsubscribe
  // footer. No transactional template gains unsubscribe semantics (FR-E009 —
  // a marketing unsubscribe must never affect a reminder/receipt/confirmation).
  | 'campaign_marketing';

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

const s = (v: unknown, fallback = ''): string =>
  v == null ? fallback : String(v);
const esc = (v: unknown): string =>
  s(v).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/** Supported locales for email copy. Anything else (including unset) falls back to English — the configured `EMAIL_DEFAULT_LOCALE`. */
const isArabic = (ctx: RenderContext): boolean => ctx.locale === 'ar';

/** Picks English or Arabic copy for the active locale — the ONE place this decision is made. */
const t = (ctx: RenderContext, en: string, ar: string): string =>
  isArabic(ctx) ? ar : en;

function layout(title: string, body: string, ctx: RenderContext): string {
  const brand = esc(ctx.brand ?? 'Ziyarati');
  const dir = isArabic(ctx) ? 'rtl' : 'ltr';
  const lang = isArabic(ctx) ? 'ar' : 'en';
  const footer = t(
    ctx,
    `You are receiving this email from ${brand}. If this wasn't you, you can ignore it.`,
    `تصلك هذه الرسالة من ${brand}. إذا لم يكن هذا أنت، يمكنك تجاهلها.`,
  );
  return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f5f7fa;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2a37" dir="${dir}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e9f0">
<tr><td style="background:#0f766e;padding:20px 28px"><span style="color:#fff;font-size:18px;font-weight:700">${brand}</span></td></tr>
<tr><td style="padding:28px">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#fafbfc;border-top:1px solid #eef1f5;color:#8a97a8;font-size:12px">
${footer}
</td></tr></table></td></tr></table></body></html>`;
}

const btn = (label: string, url: string): string =>
  `<a href="${esc(url)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">${esc(label)}</a>`;
const p = (html: string): string =>
  `<p style="margin:0 0 14px;line-height:1.6">${html}</p>`;
const h = (t: string): string =>
  `<h1 style="margin:0 0 16px;font-size:20px">${esc(t)}</h1>`;
/** One labeled row inside a credentials box (e.g. email / temporary password). */
const credRow = (label: string, value: string): string =>
  `<tr><td style="padding:6px 0 0;color:#5b6b7c;font-size:12px">${esc(label)}</td></tr>
   <tr><td style="padding:0 0 10px;font-family:ui-monospace,Consolas,monospace;font-size:15px;font-weight:600;word-break:break-all">${esc(value)}</td></tr>`;

/** Standard action email: heading + intro + button + fallback link. */
function action(
  title: string,
  greeting: string,
  intro: string,
  cta: { label: string; url: string } | null,
  outro: string,
  ctx: RenderContext,
): RenderedEmail {
  const linkNote = t(ctx, 'Or paste this link:', 'أو الصق هذا الرابط:');
  const body =
    h(title) +
    p(esc(greeting)) +
    p(esc(intro)) +
    (cta
      ? `<p style="margin:20px 0">${btn(cta.label, cta.url)}</p>` +
        p(
          `<span style="color:#8a97a8;font-size:13px">${linkNote} ${esc(cta.url)}</span>`,
        )
      : '') +
    (outro ? p(esc(outro)) : '');
  const text = [
    title,
    '',
    greeting,
    intro,
    cta ? `${cta.label}: ${cta.url}` : '',
    outro,
  ]
    .filter(Boolean)
    .join('\n');
  return { subject: title, html: layout(title, body, ctx), text };
}

const name = (v: EmailVars, ctx: RenderContext): string =>
  s(v.name, t(ctx, 'there', 'عزيزي العميل'));
/** Arabic greeting reads naturally as "مرحبًا NAME،" (comma-equivalent), matching "Hi NAME," in structure. */
const greet = (v: EmailVars, ctx: RenderContext): string =>
  t(ctx, `Hi ${name(v, ctx)},`, `مرحبًا ${name(v, ctx)}،`);
const greetDoctor = (v: EmailVars, ctx: RenderContext): string =>
  t(ctx, `Hi Dr. ${name(v, ctx)},`, `مرحبًا د. ${name(v, ctx)}،`);

export const EMAIL_TEMPLATES: Record<
  EmailTemplateKey,
  (v: EmailVars, ctx: RenderContext) => RenderedEmail
> = {
  welcome: (v, ctx) =>
    action(
      t(
        ctx,
        'Welcome to ' + s(ctx.brand ?? 'Ziyarati'),
        'مرحبًا بك في ' + s(ctx.brand ?? 'Ziyarati'),
      ),
      greet(v, ctx),
      t(
        ctx,
        `Your clinic "${s(v.clinicName, 'account')}" is set up. Let's get you started.`,
        `تم إعداد عيادتك "${s(v.clinicName, 'الحساب')}". لنبدأ معًا.`,
      ),
      {
        label: t(ctx, 'Open dashboard', 'فتح لوحة التحكم'),
        url: `${ctx.appUrl}/app/dashboard`,
      },
      t(ctx, "We're glad to have you on board.", 'يسعدنا انضمامك إلينا.'),
      ctx,
    ),

  email_verification: (v, ctx) =>
    action(
      t(ctx, 'Verify your email', 'تأكيد بريدك الإلكتروني'),
      greet(v, ctx),
      t(
        ctx,
        'Please confirm your email address to activate your account.',
        'يرجى تأكيد بريدك الإلكتروني لتفعيل حسابك.',
      ),
      {
        label: t(ctx, 'Verify email', 'تأكيد البريد الإلكتروني'),
        url: s(v.verifyUrl),
      },
      t(ctx, 'This link expires soon.', 'ستنتهي صلاحية هذا الرابط قريبًا.'),
      ctx,
    ),

  password_reset: (v, ctx) =>
    action(
      t(ctx, 'Reset your password', 'إعادة تعيين كلمة المرور'),
      greet(v, ctx),
      t(
        ctx,
        'We received a request to reset your password. If you made this request, click below.',
        'تلقينا طلبًا لإعادة تعيين كلمة المرور الخاصة بك. إذا كنت من قدّم هذا الطلب، انقر أدناه.',
      ),
      {
        label: t(ctx, 'Reset password', 'إعادة تعيين كلمة المرور'),
        url: s(v.resetUrl),
      },
      t(
        ctx,
        "If you didn't request this, no action is needed — your password is unchanged.",
        'إذا لم تطلب ذلك، فلا داعي لاتخاذ أي إجراء — لم تتغير كلمة مرورك.',
      ),
      ctx,
    ),

  appointment_confirmation: (v, ctx) =>
    action(
      t(ctx, 'Appointment confirmed', 'تم تأكيد الموعد'),
      greet(v, ctx),
      t(
        ctx,
        `Your appointment${v.service ? ` for ${s(v.service)}` : ''} is confirmed for ${s(v.dateTime)}${v.clinicName ? ` at ${s(v.clinicName)}` : ''}.`,
        `تم تأكيد موعدك${v.service ? ` لخدمة ${s(v.service)}` : ''} بتاريخ ${s(v.dateTime)}${v.clinicName ? ` في ${s(v.clinicName)}` : ''}.`,
      ),
      v.detailsUrl
        ? {
            label: t(ctx, 'View appointment', 'عرض الموعد'),
            url: s(v.detailsUrl),
          }
        : null,
      t(
        ctx,
        'Please arrive a few minutes early.',
        'يرجى الحضور قبل الموعد بدقائق قليلة.',
      ),
      ctx,
    ),

  appointment_reminder: (v, ctx) =>
    action(
      t(ctx, 'Appointment reminder', 'تذكير بالموعد'),
      greet(v, ctx),
      t(
        ctx,
        `This is a reminder of your appointment${v.service ? ` for ${s(v.service)}` : ''} on ${s(v.dateTime)}${v.clinicName ? ` at ${s(v.clinicName)}` : ''}.`,
        `هذا تذكير بموعدك${v.service ? ` لخدمة ${s(v.service)}` : ''} بتاريخ ${s(v.dateTime)}${v.clinicName ? ` في ${s(v.clinicName)}` : ''}.`,
      ),
      v.detailsUrl
        ? {
            label: t(ctx, 'View appointment', 'عرض الموعد'),
            url: s(v.detailsUrl),
          }
        : null,
      '',
      ctx,
    ),

  appointment_cancelled: (v, ctx) =>
    action(
      t(ctx, 'Appointment cancelled', 'تم إلغاء الموعد'),
      greet(v, ctx),
      t(
        ctx,
        `Your appointment on ${s(v.dateTime)} has been cancelled${v.reason ? `: ${s(v.reason)}` : '.'}`,
        `تم إلغاء موعدك بتاريخ ${s(v.dateTime)}${v.reason ? `: ${s(v.reason)}` : '.'}`,
      ),
      v.rebookUrl
        ? { label: t(ctx, 'Book again', 'حجز موعد جديد'), url: s(v.rebookUrl) }
        : null,
      '',
      ctx,
    ),

  appointment_rescheduled: (v, ctx) =>
    action(
      t(ctx, 'Appointment rescheduled', 'تم تغيير موعد الحجز'),
      greet(v, ctx),
      t(
        ctx,
        `Your appointment has been moved to ${s(v.dateTime)}.`,
        `تم نقل موعدك إلى ${s(v.dateTime)}.`,
      ),
      v.detailsUrl
        ? {
            label: t(ctx, 'View appointment', 'عرض الموعد'),
            url: s(v.detailsUrl),
          }
        : null,
      '',
      ctx,
    ),

  subscription_invoice: (v, ctx) =>
    action(
      t(ctx, 'Your invoice', 'فاتورتك'),
      greet(v, ctx),
      t(
        ctx,
        `Invoice ${s(v.invoiceNumber, '')} for ${s(v.amount)} is available for your ${s(v.planName, 'subscription')} plan.`,
        `فاتورة ${s(v.invoiceNumber, '')} بمبلغ ${s(v.amount)} متاحة الآن لباقة ${s(v.planName, 'اشتراكك')}.`,
      ),
      v.invoiceUrl
        ? {
            label: t(ctx, 'View invoice', 'عرض الفاتورة'),
            url: s(v.invoiceUrl),
          }
        : {
            label: t(ctx, 'View billing', 'عرض الفوترة'),
            url: `${ctx.appUrl}/app/billing`,
          },
      '',
      ctx,
    ),

  payment_success: (v, ctx) =>
    action(
      t(ctx, 'Payment received', 'تم استلام الدفعة'),
      greet(v, ctx),
      t(
        ctx,
        `We received your payment of ${s(v.amount)}. Thank you!`,
        `تم استلام دفعتك بمبلغ ${s(v.amount)}. شكرًا لك!`,
      ),
      v.receiptUrl
        ? { label: t(ctx, 'View receipt', 'عرض الإيصال'), url: s(v.receiptUrl) }
        : null,
      '',
      ctx,
    ),

  payment_failed: (v, ctx) =>
    action(
      t(ctx, 'Payment failed', 'فشلت عملية الدفع'),
      greet(v, ctx),
      t(
        ctx,
        `We couldn't process your payment of ${s(v.amount)}${v.reason ? ` (${s(v.reason)})` : ''}. Please update your payment method to avoid interruption.`,
        `تعذّر معالجة دفعتك بمبلغ ${s(v.amount)}${v.reason ? ` (${s(v.reason)})` : ''}. يرجى تحديث وسيلة الدفع لتجنّب انقطاع الخدمة.`,
      ),
      {
        label: t(ctx, 'Update payment', 'تحديث وسيلة الدفع'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  trial_ending: (v, ctx) =>
    action(
      t(ctx, 'Your trial is ending', 'فترتك التجريبية على وشك الانتهاء'),
      greet(v, ctx),
      t(
        ctx,
        `Your free trial ends in ${s(v.daysLeft, 'a few')} day(s). Upgrade now to keep access to all features.`,
        `تنتهي فترتك التجريبية المجانية خلال ${s(v.daysLeft, 'أيام قليلة')} يوم. قم بالترقية الآن للاحتفاظ بجميع الميزات.`,
      ),
      {
        label: t(ctx, 'Choose a plan', 'اختر باقة'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  subscription_activated: (v, ctx) =>
    action(
      t(ctx, 'Subscription activated', 'تم تفعيل الاشتراك'),
      greet(v, ctx),
      t(
        ctx,
        `Your ${s(v.planName, '')} subscription is now active.`,
        `تم تفعيل اشتراكك في باقة ${s(v.planName, '')}.`,
      ),
      {
        label: t(ctx, 'Go to dashboard', 'الذهاب إلى لوحة التحكم'),
        url: `${ctx.appUrl}/app/dashboard`,
      },
      '',
      ctx,
    ),

  subscription_renewed: (v, ctx) =>
    action(
      t(ctx, 'Subscription renewed', 'تم تجديد الاشتراك'),
      greet(v, ctx),
      t(
        ctx,
        `Your ${s(v.planName, '')} subscription renewed successfully${v.nextRenewal ? ` until ${s(v.nextRenewal)}` : ''}.`,
        `تم تجديد اشتراكك في باقة ${s(v.planName, '')} بنجاح${v.nextRenewal ? ` حتى ${s(v.nextRenewal)}` : ''}.`,
      ),
      null,
      '',
      ctx,
    ),

  subscription_cancelled: (v, ctx) =>
    action(
      t(ctx, 'Subscription cancelled', 'تم إلغاء الاشتراك'),
      greet(v, ctx),
      t(
        ctx,
        `Your subscription has been cancelled${v.endsAt ? ` and access continues until ${s(v.endsAt)}` : ''}.`,
        `تم إلغاء اشتراكك${v.endsAt ? `، ويستمر الوصول حتى ${s(v.endsAt)}` : ''}.`,
      ),
      {
        label: t(ctx, 'Reactivate', 'إعادة التفعيل'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  // FND-031 — the three grace-lifecycle notification points (before expiry,
  // at expiry, before grace end). No automatic re-billing is implied or
  // performed by any of these — informational only.
  subscription_expiring_soon: (v, ctx) =>
    action(
      t(ctx, 'Your subscription is ending soon', 'اشتراكك على وشك الانتهاء'),
      greet(v, ctx),
      t(
        ctx,
        `Your ${s(v.planName, '')} subscription ends on ${s(v.endsAt)}. Renew to avoid any interruption.`,
        `ينتهي اشتراكك في باقة ${s(v.planName, '')} بتاريخ ${s(v.endsAt)}. جدّده لتجنّب أي انقطاع في الخدمة.`,
      ),
      {
        label: t(ctx, 'Manage subscription', 'إدارة الاشتراك'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  subscription_entered_grace: (v, ctx) =>
    action(
      t(
        ctx,
        'Your subscription has ended — grace period active',
        'انتهى اشتراكك — فترة السماح سارية',
      ),
      greet(v, ctx),
      t(
        ctx,
        `Your ${s(v.planName, '')} subscription ended on ${s(v.endsAt)}. You keep full access until ${s(v.graceEndsAt)} while you renew — nothing has been charged automatically.`,
        `انتهى اشتراكك في باقة ${s(v.planName, '')} بتاريخ ${s(v.endsAt)}. ستحتفظ بالوصول الكامل حتى ${s(v.graceEndsAt)} ريثما تجدّد اشتراكك — لم يتم خصم أي مبلغ تلقائيًا.`,
      ),
      {
        label: t(ctx, 'Renew now', 'جدّد الآن'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  subscription_grace_ending_soon: (v, ctx) =>
    action(
      t(
        ctx,
        'Your grace period is ending soon',
        'فترة السماح على وشك الانتهاء',
      ),
      greet(v, ctx),
      t(
        ctx,
        `Your grace period ends on ${s(v.graceEndsAt)}. After that, new billable actions will be paused until you renew — your existing data stays fully accessible.`,
        `تنتهي فترة السماح بتاريخ ${s(v.graceEndsAt)}. بعد ذلك، ستُعلَّق الإجراءات القابلة للفوترة الجديدة حتى تجدّد اشتراكك — تظل بياناتك الحالية متاحة بالكامل.`,
      ),
      {
        label: t(ctx, 'Renew now', 'جدّد الآن'),
        url: `${ctx.appUrl}/app/billing`,
      },
      '',
      ctx,
    ),

  staff_invitation: (v, ctx) =>
    action(
      t(ctx, "You've been invited", 'تمت دعوتك'),
      greet(v, ctx),
      t(
        ctx,
        `${s(v.inviterName, 'A clinic admin')} invited you to join ${s(v.clinicName, 'their clinic')}${v.role ? ` as ${s(v.role)}` : ''}.`,
        `دعاك ${s(v.inviterName, 'مسؤول العيادة')} للانضمام إلى ${s(v.clinicName, 'عيادتهم')}${v.role ? ` بصفة ${s(v.role)}` : ''}.`,
      ),
      {
        label: t(ctx, 'Accept invitation', 'قبول الدعوة'),
        url: s(v.invitationUrl),
      },
      t(ctx, 'This invitation may expire.', 'قد تنتهي صلاحية هذه الدعوة.'),
      ctx,
    ),

  /**
   * A staff account created WITH a visible temporary password (as opposed to
   * `staff_invitation`, which hands out a set-password link instead). Shows
   * the credentials directly since the caller (StaffService.createWithNewUser)
   * already generated and displays the same password once in the admin UI.
   */
  staff_credentials: (v, ctx) => {
    const title = t(ctx, 'Your account is ready', 'حسابك جاهز');
    const intro = t(
      ctx,
      `An account was created for you${v.clinicName ? ` at ${s(v.clinicName)}` : ''}${v.role ? ` as ${s(v.role)}` : ''}. Use the temporary credentials below to sign in.`,
      `تم إنشاء حساب لك${v.clinicName ? ` في ${s(v.clinicName)}` : ''}${v.role ? ` بصفة ${s(v.role)}` : ''}. استخدم بيانات الدخول المؤقتة التالية لتسجيل الدخول.`,
    );
    const outro = t(
      ctx,
      'For your security, please change your password after signing in.',
      'لأمانك، يرجى تغيير كلمة المرور بعد تسجيل الدخول.',
    );
    const emailLabel = t(ctx, 'Email', 'البريد الإلكتروني');
    const passwordLabel = t(ctx, 'Temporary password', 'كلمة المرور المؤقتة');
    const loginLabel = t(ctx, 'Log in', 'تسجيل الدخول');
    const email = s(v.to);
    const password = s(v.temporaryPassword);
    const loginUrl = s(v.loginUrl);
    const body =
      h(title) +
      p(esc(greet(v, ctx))) +
      p(esc(intro)) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 20px;background:#f7f9fb;border:1px solid #e5e9f0;border-radius:8px;padding:2px 16px 8px">${credRow(emailLabel, email)}${credRow(passwordLabel, password)}</table>` +
      `<p style="margin:20px 0">${btn(loginLabel, loginUrl)}</p>` +
      p(esc(outro));
    const text = [
      title,
      '',
      greet(v, ctx),
      intro,
      `${emailLabel}: ${email}`,
      `${passwordLabel}: ${password}`,
      `${loginLabel}: ${loginUrl}`,
      outro,
    ].join('\n');
    return { subject: title, html: layout(title, body, ctx), text };
  },

  security_alert: (v, ctx) =>
    action(
      t(ctx, 'Security alert', 'تنبيه أمني'),
      greet(v, ctx),
      s(
        v.message,
        t(
          ctx,
          'We detected an important security event on your account.',
          'رصدنا نشاطًا أمنيًا مهمًا على حسابك.',
        ),
      ),
      v.actionUrl
        ? {
            label: t(ctx, 'Review activity', 'مراجعة النشاط'),
            url: s(v.actionUrl),
          }
        : null,
      t(
        ctx,
        'If this was you, no action is needed.',
        'إذا كان هذا أنت، فلا حاجة لاتخاذ أي إجراء.',
      ),
      ctx,
    ),

  doctor_notification: (v, ctx) =>
    action(
      s(v.title, t(ctx, 'Notification', 'إشعار')),
      greetDoctor(v, ctx),
      s(v.message),
      v.actionUrl
        ? {
            label: s(v.actionLabel, t(ctx, 'View', 'عرض')),
            url: s(v.actionUrl),
          }
        : null,
      '',
      ctx,
    ),

  patient_notification: (v, ctx) =>
    action(
      s(v.title, t(ctx, 'Notification', 'إشعار')),
      greet(v, ctx),
      s(v.message),
      v.actionUrl
        ? {
            label: s(v.actionLabel, t(ctx, 'View', 'عرض')),
            url: s(v.actionUrl),
          }
        : null,
      '',
      ctx,
    ),

  generic: (v, ctx) =>
    action(
      s(v.title, t(ctx, 'Notification', 'إشعار')),
      greet(v, ctx),
      s(v.message),
      v.actionUrl
        ? {
            label: s(v.actionLabel, t(ctx, 'Open', 'فتح')),
            url: s(v.actionUrl),
          }
        : null,
      '',
      ctx,
    ),

  /**
   * Phase 11 (US7, T131/T132/FR-E010) — marketing campaign email. Subject and
   * body are CLINIC-AUTHORED free text (escaped, never raw HTML — `body`'s
   * newlines are turned into `<br>` after escaping, so no injection is
   * possible through campaign content). A BOUNDED personalisation set
   * (`name`, `clinicName`) — not a general template-expression language.
   *
   * The unsubscribe footer lives ONLY here — see this key's docblock on the
   * `EmailTemplateKey` union. `email.templates.spec.ts` pins that no
   * transactional template contains one.
   */
  campaign_marketing: (v, ctx) => {
    const subject = s(
      v.subject,
      t(ctx, 'Update from your clinic', 'تحديث من عيادتك'),
    );
    const bodyHtml = esc(v.body).replace(/\n/g, '<br>');
    const unsubscribeNote = t(
      ctx,
      "Don't want to receive marketing emails from this clinic?",
      'لا ترغب في تلقي رسائل تسويقية من هذه العيادة؟',
    );
    const unsubscribeLabel = t(
      ctx,
      'Unsubscribe',
      'إلغاء الاشتراك في الرسائل التسويقية',
    );
    const unsubscribeUrl = s(v.unsubscribeUrl);

    const body =
      h(subject) +
      p(esc(greet(v, ctx))) +
      `<p style="margin:0 0 14px;line-height:1.6">${bodyHtml}</p>` +
      (unsubscribeUrl
        ? `<p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #eef1f5;color:#8a97a8;font-size:12px">${unsubscribeNote} <a href="${esc(unsubscribeUrl)}" style="color:#8a97a8">${esc(unsubscribeLabel)}</a></p>`
        : '');
    const text = [
      subject,
      '',
      greet(v, ctx),
      s(v.body),
      unsubscribeUrl ? `\n${unsubscribeNote} ${unsubscribeUrl}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return { subject, html: layout(subject, body, ctx), text };
  },
};

export function renderEmail(
  key: string,
  vars: EmailVars,
  ctx: RenderContext,
): RenderedEmail {
  const renderer =
    EMAIL_TEMPLATES[key as EmailTemplateKey] ?? EMAIL_TEMPLATES.generic;
  return renderer(vars, ctx);
}
