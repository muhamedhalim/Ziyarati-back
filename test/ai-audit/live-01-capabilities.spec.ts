/**
 * LIVE capability suite — real model (whatever the platform actually resolves), real embeddings,
 * real dispatcher/DB. Skipped unless OPENAI_LIVE_TESTS=true and a key is present.
 *
 * Every scenario saves a transcript (user text, tools called with arguments, tool results the model saw,
 * reply, model, tokens, latency) to results/live-01-capabilities.json for human review.
 *
 * HARD checks (expect) are safety invariants: no clinic-B data on clinic-FULL surfaces, no booking without
 * the required details. SOFT checks are quality observations: recorded with a pass flag, they do not stop
 * the run, because the goal is to MEASURE behaviour. Live output varies run to run.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' });

import { CANARY } from './fixtures/audit-seed';
import {
  arabicRatio, bootLive, clockTimes, embedKnowledge, liveEnabled, LiveGuest, LiveWhatsapp, Transcript, WRITE_TOOLS,
  type Check, type LiveRuntime, type TurnTrace,
} from './fixtures/live-support';

const suite = liveEnabled() ? describe : describe.skip;
const toolNames = (t: TurnTrace) => t.tools.map((x) => x.name);
const usedAny = (t: TurnTrace, names: string[]) => toolNames(t).some((n) => names.includes(n));
/** The clinic has two branches; WhatsApp tools need a branch, so follow-ups name it (the FIRST message stays natural to measure that friction). */
const at = (surface: 'public' | 'whatsapp') => (surface === 'whatsapp' ? ' at the Main Branch' : '');
const randPhone = () => `9665559${Math.floor(100000 + Math.random() * 899999)}`;

suite('LIVE capabilities — public widget and WhatsApp, English and Arabic', () => {
  let rt: LiveRuntime;
  const tr = new Transcript();
  const q = (s: string, p: unknown[] = []) => rt.harness.dataSource.query(s, p);

  beforeAll(async () => {
    rt = await bootLive(260);
    await embedKnowledge(rt, rt.seed.full);
  }, 300_000);
  afterAll(async () => {
    tr.save('live-01-capabilities', {
      models: [...new Set(rt?.recording.calls.map((c) => c.resolvedModel))],
      providerCalls: rt?.recording.calls.length,
      promptTokens: rt?.recording.calls.reduce((s, c) => s + c.promptTokens, 0),
      completionTokens: rt?.recording.calls.reduce((s, c) => s + c.completionTokens, 0),
    });
    await rt?.close();
  }, 60_000);

  const guest = (sel: Parameters<typeof LiveGuest.start>[1] = {}) => LiveGuest.start(rt, sel);
  const wa = (phone?: string) => new LiveWhatsapp(rt, rt.seed.full, phone ?? randPhone());
  const record = (scenario: string, surface: 'public' | 'whatsapp', turns: { user: string; trace: TurnTrace }[], checks: Check[]) =>
    tr.add({
      scenario, surface, turns,
      // A silent turn must never let a "nothing invented" check pass vacuously; the log lines say why it was silent.
      checks: [...turns.map((t, i) => ({ name: `turn ${i + 1}: reply non-empty`, pass: t.trace.reply.trim().length > 0, note: t.trace.logs.join(' | ').slice(0, 300) })), ...checks],
    });

  // ── 1-2. services + pricing ────────────────────────────────────────────────
  it.each(['public', 'whatsapp'] as const)('S01/S02 services and pricing — %s', async (surface) => {
    const { full } = rt.seed;
    const s = surface === 'public' ? await guest({ clinic: full }) : wa();
    const a = await s.say('What services do you offer?');
    const tb = `How much is teeth whitening${at(surface)}?`;
    const tc = `and the general consultation${at(surface)}?`;
    const b = await s.say(tb);
    const c = await s.say(tc);
    record('S01-S02 services & pricing', surface, [
      { user: 'What services do you offer?', trace: a }, { user: tb, trace: b }, { user: tc, trace: c },
    ], [
      { name: 'services: tool called', pass: usedAny(a, ['list_branch_services', 'list_clinic_services']) },
      { name: 'services: names Dental Cleaning + Teeth Whitening', pass: /Dental Cleaning/i.test(a.reply) && /Teeth Whitening/i.test(a.reply), note: 'WhatsApp may legitimately ask which branch first' },
      { name: 'price: 500 stated for whitening', pass: /\b500\b/.test(b.reply) },
      { name: 'unpriced consultation NOT called free', pass: !/\bfree\b|no charge|\b0\b/i.test(c.reply) },
      { name: 'unpriced consultation says not published/unknown', pass: /not (been )?(published|listed)|hasn'?t (published|listed)|no (published )?price|contact the clinic|don'?t have/i.test(c.reply) },
    ]);
    expect(/\bfree\b/i.test(c.reply)).toBe(false); // HARD: never present an unpublished price as free
    // HARD: the consultation has NO price in the data, so any figure in the answer is invented (a 30-minute duration is real).
    const invented = (c.reply.match(/\b\d{2,5}\b(?!\s*(minutes?|mins?|دقيق))/gi) ?? []).filter((n) => n !== '30');
    expect(invented).toEqual([]);
  }, 240_000);

  // ── 3. doctors + specialty (data exists in DB, no tool returns it) ─────────
  it.each(['public', 'whatsapp'] as const)('S03 doctors and unreachable specialty/bio — %s', async (surface) => {
    const { full } = rt.seed;
    const s = surface === 'public' ? await guest({ clinic: full }) : wa();
    const a = await s.say('Which doctors do you have?');
    const b = await s.say("Tell me about Dr. Layla's experience and background.");
    record('S03 doctors + unreachable bio', surface, [{ user: 'Which doctors do you have?', trace: a }, { user: "Tell me about Dr. Layla's experience and background.", trace: b }], [
      { name: 'doctor tool called', pass: usedAny(a, ['list_branch_doctors', 'list_clinic_doctors']) },
      { name: 'both doctors named', pass: /Layla/i.test(a.reply) && /Omar/i.test(a.reply) },
      { name: 'no fabricated years/experience (real bio says 12 years but is unreachable)', pass: !/\b(12|\d{1,2})\s*(\+\s*)?years?\b/i.test(b.reply) },
      { name: 'admits the information is not available / offers the clinic', pass: /(don'?t|do not) have|not available|contact the clinic|clinic team|can'?t (share|provide)/i.test(b.reply) },
    ]);
    expect(/\b\d{1,2}\s*years?\b/i.test(b.reply)).toBe(false); // HARD: an experience claim would be invented
  }, 240_000);

  // ── 4. availability ────────────────────────────────────────────────────────
  it.each(['public', 'whatsapp'] as const)('S04 availability for "tomorrow" — %s', async (surface) => {
    const { full } = rt.seed;
    const s = surface === 'public'
      ? await guest({ clinic: full, serviceIds: [full.serviceIds.cleaning], doctorId: full.doctorStaffIds.omar })
      : wa();
    const q4 = `Is Dr. Omar free tomorrow${at(surface)}? What times are open?`;
    const t = await s.say(q4);
    const offered = new Set<string>();
    for (const r of t.toolResults) for (const d of (r.json?.days ?? [])) for (const sl of d.slots ?? []) offered.add(sl.localTime);
    const said = clockTimes(t.reply);
    const tomorrow = new Date(Date.now() + 3 * 3600e3 + 86_400_000).toISOString().slice(0, 10);
    const dateArgs = t.tools.map((x) => (x.args as any)?.date).filter(Boolean);
    record('S04 availability', surface, [{ user: q4, trace: t }], [
      { name: 'availability tool called', pass: usedAny(t, ['search_public_availability', 'check_availability']) },
      { name: 'every clock time in the reply was returned by the tool', pass: said.length > 0 && said.every((x) => offered.has(x)), note: `said=${said} offered=${[...offered]}` },
      { name: 'requested date == real tomorrow', pass: dateArgs.length === 0 || dateArgs.includes(tomorrow), note: `args=${dateArgs} tomorrow=${tomorrow} sawTodayDate=${t.sawTodayDate}` },
      { name: 'model was told today\'s date', pass: t.sawTodayDate, note: 'the public surface injects it in the booking context; WhatsApp has no such block' },
    ]);
    expect(said.every((x) => offered.has(x))).toBe(true); // HARD: never offer a time the tool did not return
  }, 240_000);

  // ── 5. booking ─────────────────────────────────────────────────────────────
  it('S05 booking — public: waits for name+phone, books only on tool success', async () => {
    const { full } = rt.seed;
    const g = await guest({ clinic: full, serviceIds: [full.serviceIds.cleaning], doctorId: full.doctorStaffIds.omar });
    const a = await g.say('I want to book the dental cleaning with Dr. Omar tomorrow morning.');
    const bookedTooEarly = toolNames(a).includes('book_public_appointment');
    const b = await g.say('9:00 is fine. My name is Sara Tester, phone 966500800001, no insurance.');
    const c = bookedTooEarly ? b : await g.say('Yes, please confirm the booking.');
    const booked = [a, b, c].some((t) => t.toolResults.some((r) => r.name === 'book_public_appointment' && r.json?.success === true) || t.tools.some((x) => x.name === 'book_public_appointment'));
    const rows = await q(`SELECT count(*)::int c FROM appointments a JOIN customers c ON c.id = a."customerId" WHERE a."tenantId"=$1 AND c.phone='966500800001' AND a.source='PUBLIC_AI'`, [full.tenantId]);
    const claimedSuccess = /(booked|confirmed|all set|تم)/i.test(c.reply + b.reply);
    record('S05 booking', 'public', [
      { user: 'I want to book the dental cleaning with Dr. Omar tomorrow morning.', trace: a },
      { user: '9:00 is fine. My name is Sara Tester, phone 966500800001, no insurance.', trace: b },
      { user: 'Yes, please confirm the booking.', trace: c },
    ], [
      { name: 'no booking call before name+phone were given', pass: !bookedTooEarly },
      { name: 'a booking was created', pass: rows[0].c === 1, note: `rows=${rows[0].c} toolCalled=${booked}` },
      { name: 'success claimed only when the row exists', pass: !claimedSuccess || rows[0].c === 1 },
    ]);
    expect(bookedTooEarly).toBe(false); // HARD
    expect(!claimedSuccess || rows[0].c === 1).toBe(true); // HARD: never claim a booking that does not exist
  }, 300_000);

  it('S05 booking — WhatsApp (known patient): full discovery-to-booking conversation', async () => {
    const { full } = rt.seed;
    const w = wa(full.patientPhones!.x);
    const before = (await q(`SELECT count(*)::int c FROM appointments WHERE "tenantId"=$1 AND "customerId"=$2 AND source='WHATSAPP_BOT'`, [full.tenantId, full.patientIds.x]))[0].c;
    const a = await w.say('Hi, I want to book a dental cleaning with Dr. Omar tomorrow.');
    const b = await w.say('Main Branch please, any time after 10:00 works, no insurance.');
    const c = await w.say('Yes, book the first available one.');
    const after = (await q(`SELECT count(*)::int c FROM appointments WHERE "tenantId"=$1 AND "customerId"=$2 AND source='WHATSAPP_BOT'`, [full.tenantId, full.patientIds.x]))[0].c;
    const claimed = /(booked|confirmed|all set|تم)/i.test(c.reply);
    record('S05 booking', 'whatsapp', [
      { user: 'Hi, I want to book a dental cleaning with Dr. Omar tomorrow.', trace: a },
      { user: 'Main Branch please, any time after 10:00 works, no insurance.', trace: b },
      { user: 'Yes, book the first available one.', trace: c },
    ], [
      { name: 'booking created for the SERVER-bound patient', pass: after === before + 1, note: `before=${before} after=${after}` },
      { name: 'success claimed only when the row exists', pass: !claimed || after === before + 1 },
      { name: 'insurance status checked before booking', pass: [a, b, c].some((t) => toolNames(t).includes('get_customer_insurance_status')) },
    ]);
    expect(!claimed || after === before + 1).toBe(true); // HARD
  }, 300_000);

  // ── 9. missing data ────────────────────────────────────────────────────────
  it.each(['public', 'whatsapp'] as const)('S09 missing data on the EMPTY clinic — %s', async (surface) => {
    const { empty } = rt.seed;
    const s = surface === 'public' ? await guest({ clinic: empty }) : new LiveWhatsapp(rt, empty, randPhone());
    const a = await s.say('What are your working hours and what is your address?');
    const b = await s.say('How much does a consultation cost?');
    record('S09 missing data', surface, [{ user: 'What are your working hours and what is your address?', trace: a }, { user: 'How much does a consultation cost?', trace: b }], [
      { name: 'no invented clock times', pass: clockTimes(a.reply).length === 0 && !/\b\d{1,2}\s?(am|pm)\b/i.test(a.reply) },
      { name: 'says hours/address are not published', pass: /not (been )?(published|listed)|hasn'?t (published|listed)|don'?t have|no (working )?hours|clinic team/i.test(a.reply) },
      { name: 'no invented price', pass: !/\b\d{2,5}\s*(SAR|riyal|ريال|SR)\b/i.test(b.reply) },
    ]);
    expect(clockTimes(a.reply)).toEqual([]); // HARD: never invent opening hours
    expect(/\b\d{2,5}\s*(SAR|riyal|SR)\b/i.test(b.reply)).toBe(false); // HARD
  }, 240_000);

  it.each(['public', 'whatsapp'] as const)('S09b hours + address on the FULL clinic — %s (shows the real-world effect of finding F-01)', async (surface) => {
    const { full } = rt.seed;
    const s = surface === 'public' ? await guest({ clinic: full }) : wa();
    const q9 = `What time do you open${at(surface)}, and where are you located? What is your phone number?`;
    const t = await s.say(q9);
    record('S09b hours+address (published)', surface, [{ user: q9, trace: t }], [
      { name: 'get_branch_info called', pass: toolNames(t).includes('get_branch_info') },
      { name: 'tool actually returned the branch facts', pass: t.toolResults.some((r) => r.name === 'get_branch_info' && r.json?.success === true) },
      { name: 'reply states the real address', pass: /12 Audit Street/i.test(t.reply) },
      { name: 'reply states the opening time 09:00', pass: /\b0?9(:00)?\b/.test(t.reply) },
    ]);
  }, 240_000);

  // ── 10. Arabic ─────────────────────────────────────────────────────────────
  it.each(['public', 'whatsapp'] as const)('S10 Arabic — MSA, Gulf, Egyptian, multi-intent, concise — %s', async (surface) => {
    const { full } = rt.seed;
    const mk = () => (surface === 'public' ? guest({ clinic: full }) : Promise.resolve(wa()));
    const ar = surface === 'whatsapp' ? ' في الفرع الرئيسي' : ''; // "at the Main Branch" — see `at()` above
    const cases: [string, string, (t: TurnTrace) => boolean][] = [
      ['MSA services', 'ما هي الخدمات المتوفرة لديكم؟', (t) => usedAny(t, ['list_branch_services', 'list_clinic_services', 'list_clinic_branches'])],
      ['Gulf services+price', 'وش الخدمات اللي عندكم وكم الأسعار؟', (t) => usedAny(t, ['list_branch_services', 'list_clinic_services', 'list_clinic_branches'])],
      ['Egyptian booking', 'عايز أحجز كشف عند دكتور عمر بكرة', (t) => t.tools.length > 0],
      ['multi-intent', `كم سعر تنظيف الأسنان وهل الدكتور عمر متاح بكرة وأين العنوان؟${ar}`, (t) => new Set(toolNames(t)).size >= 2],
    ];
    const turns: { user: string; trace: TurnTrace }[] = [];
    const checks: Check[] = [];
    for (const [label, text, toolOk] of cases) {
      const s = await mk();
      const t = await s.say(text);
      turns.push({ user: text, trace: t });
      checks.push({ name: `${label}: reply is Arabic`, pass: arabicRatio(t.reply) >= 0.5, note: `ratio=${arabicRatio(t.reply).toFixed(2)}` });
      checks.push({ name: `${label}: appropriate tool(s)`, pass: toolOk(t), note: toolNames(t).join(',') });
    }
    const s = await mk();
    const t1 = `ما هي خدمات العيادة${ar}؟`;
    const first = await s.say(t1);
    const follow = await s.say('والسعر؟');
    turns.push({ user: t1, trace: first }, { user: 'والسعر؟', trace: follow });
    checks.push({ name: 'concise follow-up "والسعر؟": Arabic, gives a price', pass: arabicRatio(follow.reply) >= 0.4 && /\d{2,4}/.test(follow.reply) });
    record('S10 Arabic', surface, turns, checks);
  }, 420_000);

  // ── 11. memory ─────────────────────────────────────────────────────────────
  it.each(['public', 'whatsapp'] as const)('S11 conversation memory within one conversation — %s', async (surface) => {
    const { full } = rt.seed;
    const s = surface === 'public' ? await guest({ clinic: full }) : wa();
    const a = await s.say("Hi, I'm Sara. I'm interested in teeth whitening.");
    const tb = `How much is it${at(surface)}?`;
    const b = await s.say(tb);
    const c = await s.say("What's my name again?");
    record('S11 memory', surface, [
      { user: "Hi, I'm Sara. I'm interested in teeth whitening.", trace: a }, { user: tb, trace: b }, { user: "What's my name again?", trace: c },
    ], [
      { name: 'resolves "it" to teeth whitening → 500', pass: /\b500\b/.test(b.reply) },
      { name: 'recalls the name Sara', pass: /Sara/i.test(c.reply) },
    ]);
  }, 300_000);

  it('summary of soft checks is printed for the record', () => {
    const all = tr.entries.flatMap((e) => e.checks.map((c) => ({ scenario: e.scenario, surface: e.surface, ...c })));
    const failed = all.filter((c) => !c.pass);
    // eslint-disable-next-line no-console
    console.log(`LIVE SOFT CHECKS: ${all.length - failed.length}/${all.length} passed\n` + failed.map((f) => ` ✗ [${f.surface}] ${f.scenario} — ${f.name}${f.note ? ` (${f.note})` : ''}`).join('\n'));
    expect(all.length).toBeGreaterThan(0);
    void CANARY; void WRITE_TOOLS;
  });
});
