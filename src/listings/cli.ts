import "dotenv/config";
import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import { ingestListings, previewListings, type ListingIngestOptions } from "./ingest.js";
import type { ListingSourceKey, ListingTransactionType } from "./types.js";

const argumentsByName = new Map<string, string>();
let dryRun = false;
for (const argument of process.argv.slice(2).filter((argument) => argument !== "--")) {
  if (argument === "--dry-run") {
    if (dryRun) throw new Error("Invalid or duplicate argument: --dry-run");
    dryRun = true;
    continue;
  }
  const match = /^--(sources|transaction-types|max-pages|max-listings)=(.+)$/.exec(argument);
  if (!match || argumentsByName.has(match[1]!)) throw new Error(`Invalid or duplicate argument: ${argument}`);
  argumentsByName.set(match[1]!, match[2]!);
}
const options: ListingIngestOptions = {};
if (argumentsByName.has("sources")) options.sources = argumentsByName.get("sources")!.split(",") as ListingSourceKey[];
if (argumentsByName.has("transaction-types")) options.transactionTypes = argumentsByName.get("transaction-types")!.split(",") as ListingTransactionType[];
if (argumentsByName.has("max-pages")) options.maxPages = Number(argumentsByName.get("max-pages"));
if (argumentsByName.has("max-listings")) options.maxListings = Number(argumentsByName.get("max-listings"));

if (dryRun) {
  const result = await previewListings(options, { onProgress: (summary) => console.error(JSON.stringify(summary)) });
  console.log(JSON.stringify(result, null, 2));
  if (result.summaries.some((summary) => summary.status === "failed")) process.exitCode = 1;
} else {
  const database = createDatabase(loadDatabaseConfig());
  try {
    const result = await ingestListings(database, options, { onProgress: (summary) => console.error(JSON.stringify(summary)) });
    console.log(JSON.stringify(result, null, 2));
    if (result.summaries.some((summary) => summary.status === "failed")) process.exitCode = 1;
  } finally {
    await database.end();
  }
}
