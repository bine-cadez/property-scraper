import type { ListingIngestOptions } from "./ingest.js";

/**
 * Incremental refresh used by the five-minute production schedule.
 * RE/MAX is one search page (25 ads) per transaction type. Oglasnik is one
 * RSS page. Keller Williams is omitted: its robots.txt Crawl-delay of 30
 * seconds cannot finish a catalogue inside a five-minute slot.
 * A capped page does not retire ads that were not in that page.
 */
export const scheduledListingIngestOptions: Required<ListingIngestOptions> = {
  sources: ["re-max", "oglasnik"],
  transactionTypes: ["sale", "rent"],
  maxPages: 1,
  maxListings: 25,
};

export function listingImportAlreadyRunning(error: unknown): boolean {
  return typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: unknown }).statusCode === 409;
}
