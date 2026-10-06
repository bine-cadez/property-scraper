import "dotenv/config";
import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { ingestListings } from "./ingest.js";
import { listingImportAlreadyRunning, scheduledListingIngestOptions } from "./schedule.js";

const database = createDatabase(loadDatabaseConfig());
try {
  const result = await ingestListings(database, scheduledListingIngestOptions, {
    onProgress: (summary) => console.error(JSON.stringify(summary)),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.summaries.some((summary) => summary.status === "failed")) process.exitCode = 1;
} catch (error) {
  if (!listingImportAlreadyRunning(error)) throw error;
  console.error(JSON.stringify({ status: "skipped", reason: "A listing import is already running" }));
} finally {
  await database.end();
}
