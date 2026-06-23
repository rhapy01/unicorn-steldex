import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null;

/** True when `DATABASE_URL` is set (optional — on-chain mode works without it). */
export function isDatabaseEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Lazily connect to Postgres. Throws only when called without `DATABASE_URL`. */
export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. On-chain routes work without Postgres; DB-backed demo routes are disabled.",
    );
  }
  if (!dbInstance) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    dbInstance = drizzle(pool, { schema });
  }
  return dbInstance;
}

export * from "./schema";
