import { Pool } from "pg";

import type { AppConfig } from "../config.js";

export function createDatabase(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

