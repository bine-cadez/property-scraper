import "dotenv/config";

import { loadDatabaseConfig } from "../config.js";
import { createDatabase } from "../db/client.js";
import {
  DEFAULT_LIVE_SAMPLE_SIZE,
  DEFAULT_TRANSACTION_YEAR,
  ingestEtn,
  replaceLiveGursSample,
  validateLiveSampleSize,
  validateTransactionYear,
  type IngestProgress,
  type ImportSummary,
} from "./ingest.js";

function getArgument(name: string): string | null {
  const prefix = `--${name}=`;
  return (
    process.argv
      .find((argument) => argument.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

function logProgress(progress: IngestProgress): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...progress,
    }),
  );
}

async function main(): Promise<void> {
  const etnDirectory = getArgument("etn-dir");
  const skipLive = process.argv.includes("--skip-live");
  const requestedSampleSize =
    getArgument("sample-size") ?? DEFAULT_LIVE_SAMPLE_SIZE;
  const sampleSize = skipLive
    ? DEFAULT_LIVE_SAMPLE_SIZE
    : validateLiveSampleSize(requestedSampleSize);
  const transactionYear = validateTransactionYear(
    getArgument("transaction-year") ?? DEFAULT_TRANSACTION_YEAR,
  );
  const pool = createDatabase(loadDatabaseConfig());
  const summaries: ImportSummary[] = [];
  let retrievedAt = new Date().toISOString();

  try {
    if (!skipLive) {
      const result = await replaceLiveGursSample(pool, sampleSize, {
        onProgress: logProgress,
        transactionYear,
      });
      summaries.push(...result.summaries);
      retrievedAt = result.retrievedAt;
    }

    if (etnDirectory) {
      summaries.push(...(await ingestEtn(pool, etnDirectory)));
    }

    if (skipLive && !etnDirectory) {
      throw new Error("Nothing to import: --skip-live requires --etn-dir");
    }

    console.log(
      JSON.stringify(
        { retrievedAt, sampleSize, transactionYear, summaries },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

await main();
