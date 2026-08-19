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
    'gpt-4-turbo',
    'claude-3-opus',
    'gpt-5.6-luna',
    'not-a-model',
    'GPT-4O',
    'gpt-4o ',
  ])('rejects unregistered model "%s"', async (model) => {
    const errors = propertyErrors(await errorsFor({ model }), 'model');
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0].constraints)).toContain('model must be one of');
  });

  it('rejects a dated snapshot alias — only canonical ids may be persisted', async () => {
    // Aliases resolve for PRICING and capability lookup, but storing one would
    // pin an agent to a snapshot that silently ages out.
    const errors = propertyErrors(await errorsFor({ model: 'gpt-4o-2024-08-06' }), 'model');
    expect(errors).toHaveLength(1);
  });

  /**
   * A PREVIEW model IS in the registry — priced, capability-described, and
   * resolvable by the router when an operator names it in env. It must still be
   * refused here: an agent row is persistent tenant configuration, and a model
   * whose live compatibility has not been demonstrated has no business becoming
   * a clinic's stored default. The rejection is the release stage, not absence.
   */
  it.each(
    AI_MODEL_REGISTRY.filter((m) => m.releaseStage === 'PREVIEW').map((m) => m.id),
  )('rejects PREVIEW model %s even though it is registered', async (model) => {
    expect(isKnownModel(model)).toBe(true);
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
    ).toHaveLength(0);
  });

  it('leaves the other fields’ validation untouched', async () => {
    const errors = await errorsFor({ model: 'gpt-4o', temperature: 5 });
    expect(propertyErrors(errors, 'model')).toHaveLength(0);
    expect(propertyErrors(errors, 'temperature')).toHaveLength(1);
  });
});
