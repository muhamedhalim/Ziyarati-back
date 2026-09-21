/**
 * The server-side scope guard for the two surfaces strangers reach: the public
 * widget and a clinic's WhatsApp number (F-10).
 *
 * WHAT WAS MISSING. Scope, injection resistance and safety rested on prompt text
 * and the model's own habits. The audit's live run had the public widget write
 * Java, explain React, produce an article and answer trivia on 5 of 10 off-topic
 * asks — while refusing Python and SQL. That inconsistency is what a prompt-only
 * control looks like: the outcome depends on the model's mood, not the platform's
 * policy. The prompt now states the policy (`SCOPE` in `default-system-prompt.ts`);
 * this module is the part that does NOT depend on the model obeying it.
 *
 * TWO CHECKS, BOTH DETERMINISTIC:
 *
 *  - `screenUserMessage` runs BEFORE the model. A message that is unambiguously an
 *    attempt to change the assistant's role, extract its prompt or tools, or an
 *    ask for code / creative writing / arithmetic / trivia is answered with a fixed
 *    redirect. No model call, no tool call, no retrieval, no quota — so the abusive
 *    ask costs the clinic nothing and cannot be talked round.
 *  - `looksLikeCode` runs AFTER the model, on the reply. Whatever got past the
 *    prompt and the pre-check, code does not reach a patient.
 *
 * WHAT THIS IS NOT. It is not a topic classifier. "What is the capital of France?"
 * has no lexical signature that separates it from a clinic question without false
 * positives, and a patient blocked by mistake gets no answer at all — so the
 * patterns below are narrow on purpose and each one has a false-positive test
 * (`scope-guard.spec.ts`: yoga class, kidney function, "I react badly to
 * penicillin", a verification code, fasting instructions ...). Everything the
 * patterns do not name is left to the prompt, and that residue is what the live
 * evaluation after Phase 4 measures. A model-based classifier was NOT added: it is
 * a per-turn cost and latency on every anonymous message, it is itself
 * prompt-injectable, and its value is unmeasured until that live run.
 *
 * Deliberately not applied to the STAFF assistant: a signed-in receptionist asking
 * the dashboard assistant for help is not the abuse case, and a false positive there
 * would block real work.
 */

export type ScopeCategory =
  | 'override'
  | 'extraction'
  | 'code'
  | 'creative'
  | 'math'
  | 'trivia';

export interface ScopeVerdict {
  blocked: boolean;
  category?: ScopeCategory;
}

/** Runs the pattern list against the text; `s` (dotAll) is off — a sentence is one line. */
const any = (text: string, patterns: RegExp[]): boolean =>
  patterns.some((p) => p.test(text));

// ── change the assistant's role / drop its rules ──────────────────────────────
const OVERRIDE: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:instructions?|prompts?|guidelines?|restrictions?|constraints?|directives?|programming|system\s+message)\b/i,
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,20}\b(?:all|any|your|these|those|previous|prior|above|earlier|the\s+clinic)\b[^.!?\n]{0,20}\brules?\b/i,
  /\byou\s+are\s+now\b/i,
  /\bfrom\s+now\s+on\b[^.!?\n]{0,30}\byou\b/i,
  /\b(?:pretend|imagine)\s+(?:that\s+)?(?:i|you|we|to\s+be)\b/i,
  /\bact\s+as\s+(?:an?|if|though)\b/i,
  /\brole[\s-]?play\b/i,
  /\bjailbreak\b/i,
  /\bdeveloper\s+mode\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bDAN\s+(?:mode|prompt)\b/,
  // Arabic
  /(?:تجاهل|تجاهلي|تناسى|انسى|انسَ|أهمل|اهمل)\s+[^.!?؟\n]{0,40}(?:التعليمات|الأوامر|الاوامر|القواعد|البرومبت|القيود|ما\s+سبق|السابقة)/,
  // No trailing \b in any Arabic pattern: \b is ASCII-only in JS and never matches
  // next to an Arabic letter.
  /(?:أنت|انت)\s+(?:الآن|الان)/,
  /من\s+(?:الآن|الان)\s+فصاعد/,
  /تظاهر\s+(?:أنك|انك|بأنك|بانك|أنني|انني)/,
];

// ── extract the prompt or the tool catalogue ──────────────────────────────────
const EXTRACTION: RegExp[] = [
  /\bsystem[\s-]?prompt\b/i,
  /\b(?:hidden|secret|internal|initial|original)\s+(?:instructions?|prompt|rules)\b/i,
  /\bdeveloper\s+(?:message|instructions?)\b/i,
  /\bprompt\s+injection\b/i,
  // "your instructions" — never "the instructions": "the fasting instructions" is a patient asking.
  /\b(?:show|print|reveal|repeat|display|output|dump|leak|share|tell|give|list|recite|read|paste|send)\b[^.!?\n]{0,25}\b(?:your|ur)\s+(?:\w+\s+){0,2}(?:instructions?|prompt|guidelines|configuration)\b/i,
  /\bwhat\s+(?:are|is)\s+your\s+(?:instructions?|rules|prompt|system)\b/i,
  /\b(?:show|print|reveal|dump|list|give|tell)\b[^.!?\n]{0,25}\b(?:your|the|all)\s+(?:\w+\s+){0,2}(?:tools|functions)\b/i,
  /\bwhat\s+(?:tools|functions|commands)\s+(?:do\s+you|can\s+you|are\s+you)\b/i,
  /\bhow\s+(?:were|are)\s+you\s+(?:programmed|configured|instructed)\b/i,
  // Arabic
  /(?:اعرض|أظهر|اظهر|اطبع|اكشف|أعطني|اعطني|قل\s+لي|أخبرني|اخبرني)\s+[^.!?؟\n]{0,25}(?:التعليمات|البرومبت|الأوامر|الاوامر|الأدوات|الادوات)/,
  /(?:تعليماتك|أدواتك|ادواتك|أوامرك|برومبت)/,
];

// ── code ─────────────────────────────────────────────────────────────────────
/** A message that pastes or fences code. */
const FENCE = /```/;

/** "code" that is not programming: a promo code, a verification code, a postal code. */
const NON_PROGRAMMING_CODE =
  /\b(?:promo|promotion|discount|verification|confirmation|postal|zip|area|access|otp|insurance|voucher|coupon|booking|reference|security|qr|pin|dress|country|invoice)\s+code\b/i;

/** Write / build / debug + a programming noun. Not "class", "method", "module": a yoga class, a payment method. */
const CODE_REQUEST =
  /\b(?:write|create|generate|build|implement|develop|debug|refactor|script)\b[^.!?\n]{0,50}?\b(?:code|coding|script|scripts|function|query|snippet|regex|algorithm|component|endpoint|controller|program|software|website|webpage|api|database|sql|html|css|bot|app(?:lication)?)\b/i;

/** Unambiguous developer vocabulary: on its own it is not a clinic message. */
const DEV_TOKENS =
  /\b(?:javascript|typescript|nestjs|nextjs|node\.?js|reactjs|django|laravel|kubernetes|docker|github|npm|powershell|regex|sql|html|css|programming|source\s+code|stack\s*overflow|linked\s+list|binary\s+tree)\b|\bc\+\+/i;

/** Words that also mean something else ("I react to penicillin") — code only in a coding sentence. */
const AMBIGUOUS_DEV_TOKENS =
  /\b(?:python|java|react|rust|ruby|swift|kotlin|golang|vue|angular|php|git|algorithm|api)\b/i;
const CODING_CONTEXT =
  /\b(?:code|coding|script|programming|program|hooks?|component|framework|library|syntax|compile|developer|tutorial|array|loop|variable|linked\s+list|function|snippet)\b/i;

const CODE_AR = [
  /(?:اكتب|أكتب|برمج|اعمل|أنشئ|انشئ)\s+(?:لي\s+)?[^.!?؟\n]{0,30}(?:كود|برنامج|سكريبت|دالة|استعلام|تطبيق|موقع)/,
  /(?:بايثون|جافاسكريبت|ريأكت|برمجة)/,
];

// ── creative writing, arithmetic, trivia ─────────────────────────────────────
const CREATIVE =
  /\b(?:write|compose|draft|create|generate)\b[^.!?\n]{0,30}\b(?:article|essay|poem|poetry|haiku|story|song|lyrics|speech|blog(?:\s+post)?|novel|joke|riddle|cover\s+letter|resume|cv|paragraph|slogan|tweet)\b/i;
const CREATIVE_AR =
  /(?:اكتب|أكتب|ألف|اكتبي)\s+(?:لي\s+)?[^.!?؟\n]{0,20}(?:مقال|مقالة|قصيدة|قصة|شعر|أغنية|رواية|نكتة|موضوع\s+تعبير)/;

const MATH: RegExp[] = [
  // "17 * 23", "17 × 23", "12 ÷ 4" — never "10-12" (a range) or "12/05" (a date) or "+20…" (a phone).
  /\d\s*[*×÷]\s*\d/,
  /\b(?:solve|calculate|compute|evaluate)\b[^.!?\n]{0,15}\d+(?:\.\d+)?\s*(?:x|times|divided\s+by|plus|minus|multiplied\s+by|\/|\^)\s*\d/i,
  /\bwhat(?:'s|\s+is)\s+\d+(?:\.\d+)?\s*(?:x|times|divided\s+by|plus|minus|multiplied\s+by|\^)\s*\d/i,
];

const TRIVIA: RegExp[] = [
  /\bcapital\s+of\b/i,
  /\bpopulation\s+of\b/i,
  /\bboiling\s+point\b/i,
  /\bwho\s+(?:invented|discovered|wrote|won|painted)\b/i,
  /\bwho\s+(?:is|was)\s+the\s+(?:president|prime\s+minister|king|queen|ceo)\b/i,
  /\b(?:stock\s+price|bitcoin|football\s+score|match\s+score|world\s+cup)\b/i,
  /\bbest\s+(?:laptop|phone|smartphone|car|movie|restaurant|hotel|game)\b/i,
  /\btranslate\b[^.!?\n]{0,60}\b(?:into|to)\s+(?:english|arabic|french|spanish|german|chinese|hindi|turkish|russian)\b/i,
  /عاصمة\s+\S+/,
  /من\s+هو\s+(?:رئيس|مخترع|ملك)/,
  /أفضل\s+(?:لابتوب|هاتف|سيارة|مطعم|فيلم)/,
];

/**
 * Should this message be answered with the fixed redirect instead of going to the
 * model? First matching category wins; order is by how confident the pattern is.
 */
export function screenUserMessage(text: string): ScopeVerdict {
  const message = (text ?? '').trim();
  if (!message) return { blocked: false };

  if (any(message, OVERRIDE)) return { blocked: true, category: 'override' };
  if (any(message, EXTRACTION))
    return { blocked: true, category: 'extraction' };

  if (FENCE.test(message)) return { blocked: true, category: 'code' };
  const codeRequest =
    CODE_REQUEST.test(message) && !NON_PROGRAMMING_CODE.test(message);
  if (
    codeRequest ||
    DEV_TOKENS.test(message) ||
    (AMBIGUOUS_DEV_TOKENS.test(message) && CODING_CONTEXT.test(message)) ||
    any(message, CODE_AR)
  ) {
    return { blocked: true, category: 'code' };
  }

  if (CREATIVE.test(message) || CREATIVE_AR.test(message)) {
    return { blocked: true, category: 'creative' };
  }
  if (any(message, MATH)) return { blocked: true, category: 'math' };
  if (any(message, TRIVIA)) return { blocked: true, category: 'trivia' };
  return { blocked: false };
}

// ── the reply side ───────────────────────────────────────────────────────────
/** Independent code signals; two of them (or a fenced block) make a reply code. */
const CODE_SIGNALS: RegExp[] = [
  /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /=>\s*[{(]/,
  /\bdef\s+\w+\s*\([^)]*\)\s*:/,
  /\bclass\s+\w+\s*(?:extends\s+\w+\s*)?[{:]/,
  /^\s*import\s+\S+/m,
  /^\s*from\s+\w+\s+import\b/m,
  // Upper-case only: "select a time from the list" is a sentence, SELECT … FROM is a query.
  /\bSELECT\s+[\w*,\s.]+\s+FROM\s+\w+/,
  /\{[^}\n]*\breturn\b[^}\n]*\}/,
  /\b(?:console\.log|System\.out\.print\w*|printf|print)\s*\(/,
  /@(?:Controller|Injectable|Get|Post|Module)\s*\(/,
  /#include\s*</,
  /<\/?(?:div|span|html|body|script)\b[^>]*>/i,
];

/**
 * Is this reply code? A fenced block is enough on its own — a clinic reply has no
 * reason to contain one. Otherwise two independent signals are needed, so a single
 * stray brace or the word "function" (a kidney-function test) never trips it.
 */
export function looksLikeCode(reply: string): boolean {
  if (!reply) return false;
  if (FENCE.test(reply)) return true;
  const braceLines = (reply.match(/[{};]\s*$/gm) ?? []).length;
  let signals = braceLines >= 3 ? 1 : 0;
  for (const pattern of CODE_SIGNALS) {
    if (pattern.test(reply)) signals += 1;
    if (signals >= 2) return true;
  }
  return false;
}

// ── the redirect ─────────────────────────────────────────────────────────────
const REFUSAL_EN =
  'I can only help with this clinic — its services, doctors, opening hours, prices and your appointments. What would you like to know?';
const REFUSAL_AR =
  'أستطيع المساعدة فقط في أمور هذه العيادة: الخدمات والأطباء ومواعيد العمل والأسعار وحجز مواعيدك. بماذا يمكنني مساعدتك؟';

/** Arabic script is the majority of the message's letters. */
export function isMostlyArabic(text: string): boolean {
  const letters = (text ?? '').match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const arabic = (text.match(/[؀-ۿݐ-ݿ]/g) ?? []).length;
  return arabic / letters.length >= 0.5;
}

/**
 * The fixed redirect, in the language of what the person wrote. One text for
 * every category: it never says WHICH rule was hit, so it teaches nobody how to
 * rephrase around it.
 */
export function scopeRefusal(userText: string): string {
  return isMostlyArabic(userText) ? REFUSAL_AR : REFUSAL_EN;
}
