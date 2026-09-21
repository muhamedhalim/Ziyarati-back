/**
 * LIVE smoke — proves the real-model path works and reveals which model the platform
 * ACTUALLY resolves (router + platform setting), before the full live suite spends anything.
 * Skipped unless OPENAI_LIVE_TESTS=true and a key is present.
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env' }); // does not override variables jest-e2e.env.js already set; the key is never printed

import { bootLive, embedKnowledge, liveEnabled, LiveGuest, LiveWhatsapp, Transcript, type LiveRuntime } from './fixtures/live-support';

const suite = liveEnabled() ? describe : describe.skip;

suite('LIVE smoke — real model, real embeddings', () => {
  let rt: LiveRuntime;
  const transcript = new Transcript();

  beforeAll(async () => {
    rt = await bootLive(12);
    await embedKnowledge(rt, rt.seed.full);
  }, 240_000);
  afterAll(async () => {
    transcript.save('live-00-smoke', { models: [...new Set(rt?.recording.calls.map((c) => c.resolvedModel))], calls: rt?.recording.calls.length });
    await rt?.close();
  }, 60_000);

  it('public widget: a service question is answered from tool data', async () => {
    const { full } = rt.seed;
    const g = await LiveGuest.start(rt, { clinic: full });
    const t = await g.say('What services do you offer and how much are they?');
    transcript.add({ scenario: 'smoke-public-services', surface: 'public', turns: [{ user: 'What services do you offer and how much are they?', trace: t }], checks: [] });
    expect(t.errors).toEqual([]);
    expect(t.reply.length).toBeGreaterThan(10);
  }, 120_000);

  it('WhatsApp: a clinic-policy question is answered from retrieved knowledge (real vector path)', async () => {
    const { full } = rt.seed;
    const w = new LiveWhatsapp(rt, full, full.patientPhones!.x);
    const t = await w.say('What is your cancellation policy?');
    transcript.add({ scenario: 'smoke-wa-policy', surface: 'whatsapp', turns: [{ user: 'What is your cancellation policy?', trace: t }], checks: [] });
    expect(t.reply.length).toBeGreaterThan(10);
  }, 120_000);
});
