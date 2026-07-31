import "dotenv/config";

import { loadDatabaseConfig } from "../config.js";
import { refreshMapTables } from "../gurs/map-refresh.js";
import { createDatabase } from "./client.js";
import { applySqlMigrations } from "./sql-migrations.js";

const database = createDatabase(loadDatabaseConfig());

try {
  const applied = await applySqlMigrations(database);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await refreshMapTables(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.log(
    JSON.stringify({
      applied,
      mapRefreshed: true,
      message:
        applied.length === 0
          ? "Spatial SQL migrations are up to date"
          : "Spatial SQL migrations applied",
    }),
  );
} finally {
  await database.end();
}
