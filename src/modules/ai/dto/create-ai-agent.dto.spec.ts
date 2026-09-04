import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  AI_MODEL_IDS,
  AI_MODEL_REGISTRY,
  isKnownModel,
} from '../routing/ai-model-registry';
import { CreateAiAgentDto } from './create-ai-agent.dto';
import { UpdateAiAgentDto } from './update-ai-agent.dto';

async function errorsFor(
  payload: Record<string, unknown>,
  Cls: typeof CreateAiAgentDto | typeof UpdateAiAgentDto = CreateAiAgentDto,
) {
  return validate(plainToInstance(Cls, payload));
}

const propertyErrors = (errors: Awaited<ReturnType<typeof validate>>, property: string) =>
  errors.filter((e) => e.property === property);

/**
 * `model` was free text (`@IsString @MaxLength(100)`) and the clinic UI rendered
 * it as an open input, so a clinic admin could persist any string. It reached the
 * provider verbatim and, when unrecognized, produced UNPRICED cost rows or a hard
 * provider error. The registry is now the allow-list, enforced here at the write
 * boundary — the router additionally ignores unregistered values already stored.
 */
describe('CreateAiAgentDto — model allow-list', () => {
  it.each([...AI_MODEL_IDS])('accepts registered model %s', async (model) => {
    expect(propertyErrors(await errorsFor({ model }), 'model')).toHaveLength(0);
  });

  it.each([
    // The retired GPT-4.x family — the models this platform no longer permits.
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4-turbo',
    // Never registered here at all.
    'gpt-5.6-sol',
    'claude-3-opus',
    'not-a-model',
    // Casing and whitespace are NOT normalised at the write boundary. `findModel`
    // is lenient so a value the provider echoes back still prices; a value being
    // PERSISTED has to be the canonical id exactly, or two rows mean the same
    // model and only one of them matches on a later exact comparison.
    'GPT-5.6-LUNA',
    'gpt-5.6-luna ',
  ])('rejects unregistered model "%s"', async (model) => {
    const errors = propertyErrors(await errorsFor({ model }), 'model');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0].constraints)).toContain('model must be one of');
  });

  it('rejects a dated snapshot alias — only canonical ids may be persisted', async () => {
    // Aliases resolve for PRICING and capability lookup, but storing one would
    // pin an agent to a snapshot that silently ages out. The permitted models
    // publish no snapshots at all, so a retired one is the realistic case.
    const errors = propertyErrors(await errorsFor({ model: 'gpt-4o-2024-08-06' }), 'model');
    expect(errors).toHaveLength(1);
  });

  /**
   * A PREVIEW model IS in the registry — priced, capability-described, and
   * resolvable by the router when an operator names it in env. It must still be
   * refused here: an agent row is persistent tenant configuration, and a model
   * whose live compatibility has not been demonstrated has no business becoming
   * a clinic's stored default. The rejection is the release stage, not absence.
   *
   * There are no PREVIEW entries at present (the GPT-5.6 family was promoted to
   * GA once it passed the live gate), so this asserts the RULE over whatever the
   * registry currently holds rather than iterating a set that happens to be
   * empty — an `it.each([])` would be a hard jest error today and silent
   * non-coverage the moment someone "fixed" it.
   */
  it('rejects any PREVIEW model, even though it is registered', async () => {
    const preview = AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'PREVIEW');
    for (const model of preview) {
      expect(isKnownModel(model.id)).toBe(true);
      expect(
        propertyErrors(await errorsFor({ model: model.id }), 'model'),
      ).toHaveLength(1);
    }
  });

  /**
   * The two permitted models, and the whole of the permitted set: both are
   * first-class stored agent configuration.
   */
  it.each(['gpt-5.6-luna', 'gpt-5.6-terra'])(
    'accepts %s as a persisted agent model',
    async (model) => {
      expect(propertyErrors(await errorsFor({ model }), 'model')).toHaveLength(0);
      // Same allow-list on update, inherited via PartialType.
      expect(
        propertyErrors(await errorsFor({ model }, UpdateAiAgentDto), 'model'),
      ).toHaveLength(0);
    },
  );

  /**
   * The fabricated dated snapshots. Two of these were invented outright and one
   * (`gpt-4o-latest`) was a real-looking guess; all three were disproved against
   * GET /v1/models. They must fail validation, not resolve to a canonical id.
   */
  it.each([
    'gpt-5.6-luna-2026-06-11',
    'gpt-5.6-terra-2026-06-11',
    'gpt-4o-latest',
  ])('rejects the non-existent id %s', async (model) => {
    expect(isKnownModel(model)).toBe(false);
    expect(propertyErrors(await errorsFor({ model }), 'model')).toHaveLength(1);
  });

  it('still allows omitting the model — the platform default then applies', async () => {
    expect(propertyErrors(await errorsFor({ name: 'Reception' }), 'model')).toHaveLength(0);
  });

  it('names the allowed values in the error, so the API response is actionable', async () => {
    const errors = propertyErrors(await errorsFor({ model: 'nope' }), 'model');
    for (const id of AI_MODEL_IDS) {
      expect(JSON.stringify(errors[0].constraints)).toContain(id);
    }
  });

  it('applies the same allow-list on update (inherited via PartialType)', async () => {
    expect(
      propertyErrors(await errorsFor({ model: 'nope' }, UpdateAiAgentDto), 'model'),
    ).toHaveLength(1);
    expect(
      propertyErrors(await errorsFor({ model: 'gpt-4o' }, UpdateAiAgentDto), 'model'),
    ).toHaveLength(1);
    expect(
      propertyErrors(await errorsFor({ model: 'gpt-5.6-luna' }, UpdateAiAgentDto), 'model'),
    ).toHaveLength(0);
  });

  it('leaves the other fields validation untouched', async () => {
    const errors = await errorsFor({ model: 'gpt-5.6-luna', temperature: 5 });
    expect(propertyErrors(errors, 'model')).toHaveLength(0);
    expect(propertyErrors(errors, 'temperature')).toHaveLength(1);
  });

  /**
   * DIRECT API MANIPULATION. A clinic admin who bypasses the dashboard and
   * PATCHes `model` straight onto the endpoint is refused here, before the
   * value can ever be persisted — and even if it somehow were, the router
   * ignores it and the provider factory refuses to dispatch it. Three
   * independent layers, none of which is the UI.
   */
  it('refuses a hand-crafted request naming a third model', async () => {
    for (const forged of ['gpt-5.6-sol', 'gpt-4o', 'o3-mini', 'gemini-2.0-pro']) {
      const errors = propertyErrors(await errorsFor({ model: forged }), 'model');
      expect(errors).toHaveLength(1);
      expect(JSON.stringify(errors[0].constraints)).toContain(
        'model must be one of: gpt-5.6-luna, gpt-5.6-terra',
      );
    }
  });
});
