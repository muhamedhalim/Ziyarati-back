/**
 * Reusable unit-test mock factories.
 *
 * These produce in-memory, jest-mocked doubles for the external collaborators that
 * services depend on (TypeORM repositories, DataSource/EntityManager, BullMQ queues,
 * Redis/cache, HTTP clients, Nest's Reflector/ExecutionContext). They let us write
 * TRUE unit tests — no real database, Redis, queues, or network — and keep mock
 * wiring out of every individual spec.
 *
 * Excluded from the production build by tsconfig.build.json (`test/` is ignored).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─────────────────────────────────────────────────────────────────────────────
// TypeORM
// ─────────────────────────────────────────────────────────────────────────────

export interface MockQueryBuilder {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orWhere: jest.Mock;
  innerJoin: jest.Mock;
  leftJoin: jest.Mock;
  leftJoinAndSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  groupBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  limit: jest.Mock;
  offset: jest.Mock;
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  setParameter: jest.Mock;
  setParameters: jest.Mock;
  setLock: jest.Mock;
  setOnLocked: jest.Mock;
  returning: jest.Mock;
  getOne: jest.Mock;
  getMany: jest.Mock;
  getManyAndCount: jest.Mock;
  getRawOne: jest.Mock;
  getRawMany: jest.Mock;
  getCount: jest.Mock;
  execute: jest.Mock;
}

/** Chainable query-builder double; override the terminal getters per-test. */
export const createMockQueryBuilder = (): MockQueryBuilder => {
  const qb = {} as MockQueryBuilder;
  const chain = () => qb;
  qb.select = jest.fn(chain);
  qb.addSelect = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.andWhere = jest.fn(chain);
  qb.orWhere = jest.fn(chain);
  qb.innerJoin = jest.fn(chain);
  qb.leftJoin = jest.fn(chain);
  qb.leftJoinAndSelect = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.addOrderBy = jest.fn(chain);
  qb.groupBy = jest.fn(chain);
  qb.skip = jest.fn(chain);
  qb.take = jest.fn(chain);
  qb.limit = jest.fn(chain);
  qb.offset = jest.fn(chain);
  qb.insert = jest.fn(chain);
  qb.into = jest.fn(chain);
  qb.values = jest.fn(chain);
  qb.orIgnore = jest.fn(chain);
  qb.update = jest.fn(chain);
  qb.set = jest.fn(chain);
  qb.setParameter = jest.fn(chain);
  qb.setParameters = jest.fn(chain);
  qb.setLock = jest.fn(chain);
  qb.setOnLocked = jest.fn(chain);
  qb.returning = jest.fn(chain);
  qb.getOne = jest.fn(async () => null);
  qb.getMany = jest.fn(async () => []);
  qb.getManyAndCount = jest.fn(async () => [[], 0]);
  qb.getRawOne = jest.fn(async () => undefined);
  qb.getRawMany = jest.fn(async () => []);
  qb.getCount = jest.fn(async () => 0);
  qb.execute = jest.fn(async () => ({ affected: 1, raw: [] }));
  return qb;
};

export interface MockRepository {
  find: jest.Mock;
  findOne: jest.Mock;
  findOneBy: jest.Mock;
  findAndCount: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  softDelete: jest.Mock;
  restore: jest.Mock;
  count: jest.Mock;
  exists: jest.Mock;
  existsBy: jest.Mock;
  softRemove: jest.Mock;
  remove: jest.Mock;
  increment: jest.Mock;
  decrement: jest.Mock;
  createQueryBuilder: jest.Mock;
}

/**
 * A jest-mocked TypeORM Repository. `create` echoes its input (matching TypeORM's
 * synchronous entity-construction behaviour); `save` echoes by default. Override
 * any method per-test with `.mockResolvedValueOnce(...)`.
 */
export const createMockRepository = (): MockRepository => ({
  find: jest.fn(async () => []),
  findOne: jest.fn(async () => null),
  findOneBy: jest.fn(async () => null),
  findAndCount: jest.fn(async () => [[], 0]),
  save: jest.fn(async (entity: any) => entity),
  create: jest.fn((data: any) => data),
  update: jest.fn(async () => ({ affected: 1 })),
  delete: jest.fn(async () => ({ affected: 1 })),
  softDelete: jest.fn(async () => ({ affected: 1 })),
  restore: jest.fn(async () => ({ affected: 1 })),
  count: jest.fn(async () => 0),
  exists: jest.fn(async () => false),
  existsBy: jest.fn(async () => false),
  softRemove: jest.fn(async (entity: any) => entity),
  remove: jest.fn(async (entity: any) => entity),
  increment: jest.fn(async () => ({ affected: 1 })),
  decrement: jest.fn(async () => ({ affected: 1 })),
  createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
});

export interface MockEntityManager {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  getRepository: jest.Mock;
  query: jest.Mock;
  createQueryBuilder: jest.Mock;
}

/**
 * EntityManager double used inside `DataSource.transaction(manager => …)`.
 * `create(Entity, data)` returns `data`; `save` stamps a generated id when absent
 * so callers that read `saved.id` keep working.
 *
 * Pass `repoMap` (a Map keyed by the entity class) to make `getRepository(Entity)`
 * return a STABLE mock per entity — required by services that program
 * `manager.getRepository(X).findOne/save/...`. Unregistered entities lazily get a
 * fresh repo that is cached, so repeated lookups return the same instance.
 */
export const createMockEntityManager = (
  repoMap: Map<unknown, MockRepository> = new Map(),
): MockEntityManager => ({
  create: jest.fn((_entity: any, data?: any) => data ?? _entity),
  save: jest.fn(async (entity: any) =>
    entity && typeof entity === 'object' && !Array.isArray(entity)
      ? { id: entity.id ?? 'generated-id', ...entity }
      : entity,
  ),
  findOne: jest.fn(async () => null),
  find: jest.fn(async () => []),
  update: jest.fn(async () => ({ affected: 1 })),
  delete: jest.fn(async () => ({ affected: 1 })),
  getRepository: jest.fn((entity: unknown) => {
    let repo = repoMap.get(entity);
    if (!repo) {
      repo = createMockRepository();
      repoMap.set(entity, repo);
    }
    return repo;
  }),
  query: jest.fn(async () => []),
  createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
});

export interface MockDataSource {
  manager: MockEntityManager;
  transaction: jest.Mock;
  createQueryBuilder: jest.Mock;
  query: jest.Mock;
  getRepository: jest.Mock;
}

/**
 * DataSource double whose `transaction()` invokes the callback with a shared mock
 * manager (exposed as `.manager` so tests can program it). Supports both the
 * `transaction(cb)` and `transaction(isolationLevel, cb)` overloads.
 */
export const createMockDataSource = (
  manager: MockEntityManager = createMockEntityManager(),
): MockDataSource => ({
  manager,
  transaction: jest.fn(async (arg1: any, arg2?: any) => {
    const cb = typeof arg1 === 'function' ? arg1 : arg2;
    return cb(manager);
  }),
  createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
  query: jest.fn(async () => []),
  getRepository: jest.fn(() => createMockRepository()),
});

// ─────────────────────────────────────────────────────────────────────────────
// Nest config / jwt
// ─────────────────────────────────────────────────────────────────────────────

/** ConfigService double: `get(key, default)` returns the override or the default. */
export const createMockConfigService = (overrides: Record<string, unknown> = {}) => ({
  get: jest.fn((key: string, defaultValue?: unknown) =>
    Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaultValue,
  ),
  getOrThrow: jest.fn((key: string) => overrides[key]),
});

export const createMockJwtService = () => ({
  signAsync: jest.fn(async () => 'signed.jwt.token'),
  sign: jest.fn(() => 'signed.jwt.token'),
  verifyAsync: jest.fn(),
  verify: jest.fn(),
});

// ─────────────────────────────────────────────────────────────────────────────
// BullMQ / Redis / HTTP (for later phases)
// ─────────────────────────────────────────────────────────────────────────────

export const createMockQueue = () => ({
  add: jest.fn(async () => ({ id: 'job-1' })),
  addBulk: jest.fn(async () => [{ id: 'job-1' }]),
  getJob: jest.fn(async () => null),
  getJobCounts: jest.fn(async () => ({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 })),
  remove: jest.fn(async () => undefined),
  close: jest.fn(async () => undefined),
  client: Promise.resolve({ ping: jest.fn(), eval: jest.fn(), get: jest.fn(), set: jest.fn() }),
});

export const createMockCache = () => ({
  get: jest.fn(async () => null),
  set: jest.fn(async () => undefined),
  del: jest.fn(async () => undefined),
  eval: jest.fn(async () => [0, 0]),
  ping: jest.fn(async () => 'PONG'),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
});

export const createMockHttpService = () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  patch: jest.fn(),
  delete: jest.fn(),
  request: jest.fn(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Nest guards / interceptors
// ─────────────────────────────────────────────────────────────────────────────

export const createMockReflector = () => ({
  get: jest.fn(),
  getAll: jest.fn(),
  getAllAndMerge: jest.fn(),
  getAllAndOverride: jest.fn(),
});

/** Minimal ExecutionContext double for HTTP guards. */
export const createMockExecutionContext = (request: any = {}): any => ({
  switchToHttp: () => ({
    getRequest: () => request,
    getResponse: () => request.res ?? {},
    getNext: () => ({}),
  }),
  getHandler: () => request.__handler ?? ((): void => undefined),
  getClass: () => request.__class ?? class MockController {},
  getType: () => 'http',
  getArgs: () => [request],
  getArgByIndex: () => request,
  switchToRpc: () => ({}),
  switchToWs: () => ({}),
});
