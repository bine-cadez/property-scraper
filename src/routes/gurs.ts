import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";

import {
  DEFAULT_TRANSACTION_YEAR,
  MAX_LIVE_SAMPLE_SIZE,
  replaceLiveGursSample,
  type LiveIngestOptions,
  type LiveIngestResult,
} from "../gurs/ingest.js";

export type GursIngest = (
  database: Pool,
  sampleSize: number,
  options?: LiveIngestOptions,
) => Promise<LiveIngestResult>;

type IngestBody = {
  sampleSize: number;
  transactionYear?: number;
};

export function gursRoutes(
  database: Pool,
  ingest: GursIngest = replaceLiveGursSample,
): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Body: IngestBody }>(
      "/ingest/gurs",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["sampleSize"],
            properties: {
              sampleSize: {
                type: "integer",
                minimum: 1,
                maximum: MAX_LIVE_SAMPLE_SIZE,
                description:
                  "How many recent property transactions to use as the starting sample.",
              },
              transactionYear: {
                type: "integer",
                minimum: 2007,
                maximum: 2100,
                default: DEFAULT_TRANSACTION_YEAR,
                description:
                  "The year whose property transactions should be imported.",
              },
            },
          },
        },
      },
      async (request) =>
        ingest(database, request.body.sampleSize, {
          transactionYear:
            request.body.transactionYear ?? DEFAULT_TRANSACTION_YEAR,
          onProgress: (progress) => {
            request.log.info({ progress }, "GURS ingest progress");
          },
        }),
    );
  };
}
