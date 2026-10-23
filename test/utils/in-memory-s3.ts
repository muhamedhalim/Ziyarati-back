import type { INestApplication } from '@nestjs/common';

import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * An in-memory stand-in for the AWS S3 client, installed INTO the real `StorageService`.
 *
 * Why not mock `StorageService`: its key shape, tenant-prefix assertions, upload policy and
 * magic-byte checks are exactly what several security specs exist to exercise, so those must stay the
 * real code. Only the network edge (`S3Client.send`) is replaced. Nothing here can reach AWS: there is
 * no client, no credential chain and no network call (CR-55 — specs used to write to the developer's
 * real bucket, and failed in CI where no bucket was configured).
 *
 * Supported commands are the ones `StorageService` issues: Put / Head / Get / Delete / DeleteObjects /
 * ListObjectsV2 / ListObjectVersions. Anything else throws, so a new storage call is noticed rather
 * than silently ignored.
 */
export interface InMemoryS3 {
  /** key -> stored bytes + content type */
  objects: Map<string, { body: Buffer; contentType?: string; metadata?: Record<string, string> }>;
  /** Names of every command issued, in order — lets a spec assert "no storage call happened". */
  commands: string[];
}

class NotFoundError extends Error {
  readonly name = 'NotFound';
  readonly $metadata = { httpStatusCode: 404 };
}

export function installInMemoryS3(app: INestApplication): InMemoryS3 {
  const state: InMemoryS3 = { objects: new Map(), commands: [] };

  const fakeClient = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const kind = command.constructor.name;
      state.commands.push(kind);
      const input = command.input;
      switch (kind) {
        case 'PutObjectCommand': {
          const body = input.Body;
          state.objects.set(String(input.Key), {
            body: Buffer.isBuffer(body) ? body : Buffer.from(body as Uint8Array),
            contentType: input.ContentType as string | undefined,
            metadata: input.Metadata as Record<string, string> | undefined,
          });
          return {};
        }
        case 'HeadObjectCommand': {
          const hit = state.objects.get(String(input.Key));
          if (!hit) throw new NotFoundError('Not Found');
          return { ContentLength: hit.body.length, ContentType: hit.contentType, Metadata: hit.metadata };
        }
        case 'GetObjectCommand': {
          const hit = state.objects.get(String(input.Key));
          if (!hit) throw new NotFoundError('Not Found');
          return {
            ContentType: hit.contentType,
            ContentLength: hit.body.length,
            Body: { transformToByteArray: async () => new Uint8Array(hit.body) },
          };
        }
        case 'DeleteObjectCommand':
          state.objects.delete(String(input.Key));
          return {};
        case 'DeleteObjectsCommand': {
          const objects = ((input.Delete as { Objects?: { Key: string }[] })?.Objects ?? []);
          for (const o of objects) state.objects.delete(o.Key);
          return { Deleted: objects.map((o) => ({ Key: o.Key })) };
        }
        case 'ListObjectsV2Command': {
          const prefix = String(input.Prefix ?? '');
          const keys = [...state.objects.keys()].filter((k) => k.startsWith(prefix));
          return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false, KeyCount: keys.length };
        }
        case 'ListObjectVersionsCommand': {
          const prefix = String(input.Prefix ?? '');
          const keys = [...state.objects.keys()].filter((k) => k.startsWith(prefix));
          return { Versions: keys.map((Key) => ({ Key, VersionId: 'v1' })), DeleteMarkers: [], IsTruncated: false };
        }
        default:
          throw new Error(`in-memory S3: unsupported command ${kind}`);
      }
    },
  };

  // The service reads its bucket/region once, in its constructor, and builds the client lazily. The
  // e2e environment blanks S3_BUCKET (jest-e2e.env.js), so set both fields and pre-install the client:
  // `getClient()` then returns this fake and never constructs a real `S3Client`.
  const storage = app.get(StorageService) as unknown as Record<string, unknown>;
  storage.bucket = 'in-memory-test-bucket';
  storage.region = 'eu-central-1';
  storage.client = fakeClient;

  return state;
}
