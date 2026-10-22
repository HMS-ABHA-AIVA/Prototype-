import "dotenv/config";

// A hosted database can be slow to answer the first connection after idling. Prisma's default is to give up after 5
// seconds; tests wait longer. Import this file before anything that creates the Prisma client.
const url = process.env.DATABASE_URL;
if (url && !/connect_timeout=/.test(url)) {
  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}connect_timeout=30&pool_timeout=30`;
}
