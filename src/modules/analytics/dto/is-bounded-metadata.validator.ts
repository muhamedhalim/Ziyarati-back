import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Hard bounds on event `metadata` to stop storage-amplification / write-DoS. */
export const METADATA_MAX_BYTES = 8 * 1024; // 8 KB serialized
export const METADATA_MAX_KEYS = 100;
export const METADATA_MAX_DEPTH = 5;

interface Walk {
  keys: number;
  depth: number;
  ok: boolean;
}

function walk(value: unknown, depth: number): Walk {
  if (depth > METADATA_MAX_DEPTH) return { keys: 0, depth, ok: false };
  if (value === null || typeof value !== 'object') return { keys: 0, depth, ok: true };

  let keys = 0;
  let maxDepth = depth;
  for (const v of Object.values(value as Record<string, unknown>)) {
    keys += 1;
    const child = walk(v, depth + 1);
    if (!child.ok) return { keys, depth: child.depth, ok: false };
    keys += child.keys;
    if (child.depth > maxDepth) maxDepth = child.depth;
  }
  return { keys, depth: maxDepth, ok: true };
}

@ValidatorConstraint({ name: 'isBoundedMetadata', async: false })
export class IsBoundedMetadataConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === undefined || value === null) return true; // optional
    if (typeof value !== 'object' || Array.isArray(value)) return false;

    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), 'utf8'); // throws on circular
    } catch {
      return false;
    }
    if (bytes > METADATA_MAX_BYTES) return false;

    const result = walk(value, 1);
    return result.ok && result.keys <= METADATA_MAX_KEYS;
  }

  defaultMessage(_args: ValidationArguments): string {
    return `metadata must be a plain object ≤ ${METADATA_MAX_BYTES} bytes, ≤ ${METADATA_MAX_KEYS} total keys, and nested ≤ ${METADATA_MAX_DEPTH} levels`;
  }
}

/** Validates that a value is a bounded plain JSON object (size/keys/depth). */
export function IsBoundedMetadata(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      constraints: [],
      validator: IsBoundedMetadataConstraint,
    });
  };
}
