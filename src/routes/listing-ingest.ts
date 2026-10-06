import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { ingestListings, validateListingIngestOptions, type ListingIngestOptions, type ListingIngestResult, type ListingIngestDependencies } from "../listings/ingest.js";
import { listingSourceKeys } from "../listings/sources/index.js";

export type ListingsIngest = (database: Pool, options?: ListingIngestOptions, dependencies?: ListingIngestDependencies) => Promise<ListingIngestResult>;

export function listingIngestRoutes(database: Pool, ingest: ListingsIngest = ingestListings): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Body: ListingIngestOptions }>("/ingest/listings", {
      schema: {
        summary: "Import sale and rental advertisements",
        description: "Downloads and saves ads from supported sources separately from GURS. Limits apply per source and transaction type. Partial imports preserve unseen ads; only complete successful catalogues can retire missing ads. Returns per-source results, including failures and location coverage.",
        body: {
          type: "object", additionalProperties: true,
          properties: {
            sources: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: listingSourceKeys }, description: "Defaults to sources enabled in /listings/sources, or LISTING_SOURCES when that variable is set." },
            transactionTypes: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: ["sale", "rent"] }, default: ["sale", "rent"] },
            maxPages: { type: "integer", minimum: 1, maximum: 100, default: 1 },
            maxListings: { type: "integer", minimum: 1, maximum: 2000, default: 50 },
          },
        },
      },
    }, async (request) => ingest(database, validateListingIngestOptions(request.body ?? {}), { onProgress: (summary) => request.log.info({ summary }, "Listing ingest progress") }));
  };
}
