import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

/**
 * The database layer of the hospital modules (src/hospital). They run plain SQL (merged from AIVA OSHealth) on the same
 * PostgreSQL database and the same tables Prisma manages; Prisma remains the owner of the schema (prisma/migrations).
 *
 * Hospitals are kept apart by facilityId. Every statement on a hospital table names its hospital with the placeholder
 * `:fid`, which this layer fills with the hospital of the signed-in staff member:
 *
 *     db.query('SELECT id, name FROM "Encounter" WHERE "facilityId" = :fid AND id = $1', [id])
 *
 * The hospital comes from the request scope opened by the sign-in middleware (hospital/auth/session.ts). A statement that
 * uses :fid outside such a scope is refused, so a query can never silently run for "no hospital" or for all of them.
 * tests/hospital-sql-scope.test.ts checks that every statement on a hospital table carries :fid.
 *
 * Rows come back with camelCase keys (the columns already are; snake_case aliases are converted), numbers as numbers,
 * dates as 'YYYY-MM-DD' and instants as Date objects.
 */
export interface Queryable {
  /** The hospital this work is for. Throws when there is none in scope. */
  readonly fid: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  /** Runs a statement and returns the number of affected rows. */
  execute(sql: string, params?: unknown[]): Promise<number>;
}

export interface Transactional extends Queryable {
  /** Everything inside succeeds or fails together. Pass `tx` (not the outer db) to the work inside. */
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface Database extends Transactional {
  /** Work that belongs to no single hospital (the platform console, sign-in look-ups). `:fid` is refused here. */
  readonly platform: Transactional;
  /** Runs `work` with `hospitalId` as the hospital in scope (the sign-in middleware does this for every request). */
  inFacility<T>(hospitalId: string, work: () => T): T;
  /** The hospital in scope, or null. */
  currentFacility(): string | null;
  close(): Promise<void>;
}

// Numbers as numbers, DATE as 'YYYY-MM-DD'. Columns created by the original hmsmerge migrations are `timestamp without
// time zone` holding UTC (that is how Prisma writes them), so they are read as UTC, not as the server's local time.
pg.types.setTypeParser(20, (v) => Number(v)); // bigint
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1114, (v) => new Date(`${v.replace(" ", "T")}Z`)); // timestamp (UTC)

/** 'abha_number' -> 'abhaNumber'. camelCase keys are left as they are. */
export function camelizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase())] = value;
  return out;
}

const FID = /(?<!:):fid\b/g;
const HAS_FID = /(?<!:):fid\b/;

/** Thrown when hospital SQL runs outside a hospital's scope. A programming error: it must never reach a user as data. */
export class NoFacilityScopeError extends Error {
  constructor() {
    super("Hospital data was requested outside a signed-in hospital's scope");
    this.name = "NoFacilityScopeError";
  }
}

// Prisma reads options from the connection string that the PostgreSQL driver does not know; leave them out.
const PRISMA_ONLY_PARAMS = ["schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout", "statement_cache_size", "connect_timeout"];

export function poolConfigFrom(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  for (const name of PRISMA_ONLY_PARAMS) url.searchParams.delete(name);
  return { connectionString: url.toString(), max: Number(process.env.HOSPITAL_DB_POOL_MAX) || 10, connectionTimeoutMillis: 30_000, idleTimeoutMillis: 30_000 };
}

export function createDatabase(databaseUrl: string, makePool: (config: pg.PoolConfig) => pg.Pool = (config) => new pg.Pool(config)): Database {
  const pool = makePool(poolConfigFrom(databaseUrl));
  // A connection that drops while idle (hosted databases close idle connections) must not crash the process.
  pool.on("error", (error) => console.error("Hospital database connection error", error.message));
  const scope = new AsyncLocalStorage<string>();

  const currentFacility = () => scope.getStore() ?? null;
  const requireFacility = () => {
    const fid = currentFacility();
    if (!fid) throw new NoFacilityScopeError();
    return fid;
  };

  /** Replaces :fid with the next positional parameter. `platform` statements may not use it. */
  const bind = (sql: string, params: unknown[], platform: boolean): [string, unknown[]] => {
    if (!HAS_FID.test(sql)) return [sql, params];
    if (platform) throw new Error("A platform statement cannot use :fid");
    const position = params.length + 1;
    return [sql.replace(FID, `$${position}`), [...params, requireFacility()]];
  };

  type Run = (text: string, values: unknown[]) => Promise<pg.QueryResult>;

  /**
   * A transaction holds one connection, which runs one statement at a time: statements started together (Promise.all) are
   * queued here, in the order they were issued, rather than handed to the driver while it is busy.
   */
  const oneAtATime = (client: pg.PoolClient): Run => {
    let last: Promise<unknown> = Promise.resolve();
    return (text, values) => {
      const next = last.then(() => client.query(text, values));
      last = next.catch(() => undefined);
      return next;
    };
  };

  const wrap = (run: Run, platform: boolean): Queryable => ({
    get fid() {
      return requireFacility();
    },
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await run(...bind(sql, params, platform));
      return result.rows.map((row) => camelizeRow(row) as T);
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      const result = await run(...bind(sql, params, platform));
      const row = result.rows[0];
      return row ? (camelizeRow(row) as T) : null;
    },
    async execute(sql, params = []) {
      const result = await run(...bind(sql, params, platform));
      return result.rowCount ?? 0;
    },
  });

  const transaction = (platform: boolean) => async <T>(work: (tx: Queryable) => Promise<T>): Promise<T> => {
    if (!platform) requireFacility(); // fail before taking a connection
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(wrap(oneAtATime(client), platform));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  const onPool: Run = (text, values) => pool.query(text, values);
  const facilityDb = wrap(onPool, false);
  const platformDb = wrap(onPool, true);
  return {
    get fid() {
      return requireFacility();
    },
    query: facilityDb.query,
    queryOne: facilityDb.queryOne,
    execute: facilityDb.execute,
    transaction: transaction(false),
    platform: {
      get fid(): string {
        throw new NoFacilityScopeError();
      },
      query: platformDb.query,
      queryOne: platformDb.queryOne,
      execute: platformDb.execute,
      transaction: transaction(true),
    },
    inFacility: (hospitalId, work) => scope.run(hospitalId, work),
    currentFacility,
    close: () => pool.end(),
  };
}
