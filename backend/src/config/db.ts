import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// A hosted database can be slow to answer the first connection after it has been idle (Neon suspends idle databases).
// The driver's default is to give up quickly, which showed up as a 500 on the first request. Wait longer instead.
const CONNECT_TIMEOUT_MS = 30_000;

/** The connection string without the Prisma-only parameters (connect_timeout, pool_timeout, schema ...) the pg driver does not know. */
function connectionStringFrom(raw: string): string {
  const url = new URL(raw);
  for (const key of ["connect_timeout", "pool_timeout", "connection_limit", "pgbouncer", "schema", "socket_timeout"]) url.searchParams.delete(key);
  return url.toString();
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not configured");

export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: connectionStringFrom(databaseUrl),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    max: Number(process.env.PRISMA_POOL_MAX) || 10,
  }),
});
