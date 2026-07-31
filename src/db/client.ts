import { Pool } from "pg";

import type { DatabaseConfig } from "../config.js";

export function createDatabase(config: DatabaseConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
