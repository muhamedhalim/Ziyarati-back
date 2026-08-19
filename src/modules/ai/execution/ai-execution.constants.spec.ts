import {
  AI_EXECUTION_MODE,
  AI_FEATURE,
  FEATURE_EXECUTION_MODE,
  featureForChannel,
} from './ai-execution.constants';

/**
 * The channel→feature map is what every feature-keyed policy (model tier,
 * execution mode) actually keys on. Before it existed each call site passed the
 * literal 'chat', which made `AI_POWERFUL_FEATURES` an all-or-nothing switch and
 * left the cost ledger unable to tell a guest booking turn from a staff one.
 */
describe('featureForChannel', () => {
  it.each([
    ['WHATSAPP', AI_FEATURE.WHATSAPP_CHAT],
    ['WEBSITE', AI_FEATURE.BOOKING_CHAT],
    ['DASHBOARD', AI_FEATURE.CHAT],
    ['API', AI_FEATURE.CHAT],
  ])('maps channel %s to %s', (channel, expected) => {
    expect(featureForChannel(channel)).toBe(expected);
  });

  it('is case-insensitive — the column is a free varchar', () => {
    expect(featureForChannel('whatsapp')).toBe(AI_FEATURE.WHATSAPP_CHAT);
    expect(featureForChannel('WhAtSaPp')).toBe(AI_FEATURE.WHATSAPP_CHAT);
    expect(featureForChannel('website')).toBe(AI_FEATURE.BOOKING_CHAT);
  });

  it.each(['MOBILE', 'VOICE', 'TELEGRAM', 'MESSENGER', '', 'something-new'])(
    'falls back to CHAT for unmapped channel "%s"',
    (channel) => {
      expect(featureForChannel(channel)).toBe(AI_FEATURE.CHAT);
    },
  );

  /**
   * The load-bearing invariant: an interactive turn must never be classifiable
   * into the asynchronous batch route. A human is waiting on every one of these.
   */
  it.each([
    'WHATSAPP',
    'WEBSITE',
    'DASHBOARD',
    'API',
    'MOBILE',
    'VOICE',
    'anything-unmapped',
  ])('never maps channel "%s" onto a BATCH-mode feature', (channel) => {
    const feature = featureForChannel(channel);
    expect(FEATURE_EXECUTION_MODE[feature]).toBe(AI_EXECUTION_MODE.STANDARD);
  });

  it('only ever returns a feature the execution-mode map knows about', () => {
    for (const channel of ['WHATSAPP', 'WEBSITE', 'API', 'zzz']) {
      expect(FEATURE_EXECUTION_MODE[featureForChannel(channel)]).toBeDefined();
    }
  });
});
