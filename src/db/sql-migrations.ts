import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations/sql",
);

export async function applySqlMigrations(database: Pool): Promise<string[]> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
  const client = await database.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_sql_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const file of files) {
      const existing = await client.query<{ version: string }>(
        "SELECT version FROM public.app_sql_migrations WHERE version = $1",
        [file],
      );

      if (existing.rowCount) {
        continue;
      }

      const sql = await readFile(join(migrationDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.app_sql_migrations (version) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
  }

  return applied;
}
