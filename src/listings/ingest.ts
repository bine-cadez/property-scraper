import { setTimeout as delay } from "node:timers/promises";
import axios from "axios";
import type { Pool, PoolClient } from "pg";

import { ApiValidationError } from "../gurs/query.js";
import { listingAdapters, listingSources } from "./sources/index.js";
import type { ListingSourceAdapter, ListingSourceKey, ListingTransactionType, NormalizedListing } from "./types.js";

export type ListingIngestOptions = {
  sources?: ListingSourceKey[];
  transactionTypes?: ListingTransactionType[];
  maxPages?: number;
  maxListings?: number;
};
export type ListingImportSummary = {
  source: ListingSourceKey;
  transactionType: ListingTransactionType;
  status: "success" | "failed";
  pages: number;
  saved: number;
  skipped: number;
  located: number;
  complete: boolean;
  deactivated: number;
  error?: string;
};
export type ListingIngestResult = {
  retrievedAt: string;
  summaries: ListingImportSummary[];
};
export type ListingFetchHtml = (url: string, source: ListingSourceAdapter) => Promise<string>;
export type ListingIngestDependencies = {
  adapters?: Partial<Record<ListingSourceKey, ListingSourceAdapter>>;
  fetchHtml?: ListingFetchHtml;
  onProgress?: (summary: ListingImportSummary) => void;
};

export function validateListingIngestOptions(options: ListingIngestOptions = {}): Required<ListingIngestOptions> {
  const unknown = Object.keys(options).filter((name) => !["sources", "transactionTypes", "maxPages", "maxListings"].includes(name));
  if (unknown.length) throw new ApiValidationError(`Unknown import option: ${unknown.join(", ")}`);
  const sources = options.sources ?? listingSources.filter((source) => source.enabled).map((source) => source.key);
  const transactionTypes = options.transactionTypes ?? ["sale", "rent"];
  const maxPages = options.maxPages ?? 1;
  const maxListings = options.maxListings ?? 50;
  if (!Array.isArray(sources) || sources.length === 0 || new Set(sources).size !== sources.length || sources.some((key) => !listingSources.some((source) => source.key === key))) {
    throw new ApiValidationError("sources must contain distinct known listing sources");
  }
  if (!Array.isArray(transactionTypes) || transactionTypes.length === 0 || new Set(transactionTypes).size !== transactionTypes.length || transactionTypes.some((type) => type !== "sale" && type !== "rent")) {
    throw new ApiValidationError("transactionTypes must contain sale, rent, or both, without duplicates");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new ApiValidationError("maxPages must be an integer between 1 and 100");
  }
  if (!Number.isInteger(maxListings) || maxListings < 1 || maxListings > 2000) {
    throw new ApiValidationError("maxListings must be an integer between 1 and 2000 per source and transaction type");
  }
  return { sources, transactionTypes, maxPages, maxListings };
}

export function assertListingSourceUrl(value: string, source: ListingSourceAdapter): void {
  const url = new URL(value);
  const hostname = new URL(source.homepage).hostname.replace(/^www\./, "");
  if (url.protocol !== "https:" || url.hostname.replace(/^www\./, "") !== hostname || url.username || url.password || url.port) {
    throw new Error(`Refusing a URL outside ${source.name}`);
  }
}

// One request at a time, with a delay and bounded retries. Challenges are errors,
// never empty catalogues, so they cannot cause existing ads to be retired.
export function createListingFetcher(
  wait: (milliseconds: number) => Promise<unknown> = delay,
): ListingFetchHtml {
  return async (originalUrl, source) => {
    let url = originalUrl;
    for (let attempt = 0; attempt < 3; attempt++) {
      assertListingSourceUrl(url, source);
      await wait(1500);
      let response;
      try {
        response = await axios.get<string>(url, {
          timeout: 30_000,
          responseType: "text",
          maxContentLength: 5 * 1024 * 1024,
          maxRedirects: 0,
          validateStatus: () => true,
          headers: { "User-Agent": "PropertyScraper/0.1 (+listing catalogue import)", Accept: "text/html" },
        });
      } catch (error) {
        if (attempt === 2) throw error;
        await wait(1000 * 2 ** attempt);
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (typeof location !== "string") throw new Error(`Invalid redirect from ${source.name}`);
        url = new URL(location, url).href;
        assertListingSourceUrl(url, source);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 2) throw new Error(`${source.name} returned HTTP ${response.status}`);
        const retryAfter = response.headers["retry-after"];
        const seconds = typeof retryAfter === "string" ? Number(retryAfter) : NaN;
        await wait(Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1000)) : 1000 * 2 ** attempt);
        continue;
      }
      if (response.status !== 200) throw new Error(`${source.name} returned HTTP ${response.status}`);
      const html = response.data;
      if (typeof html !== "string" || !html.trim() || /cf-chl-|<title>\s*(?:just a moment|attention required)|captcha-delivery/i.test(html)) {
        throw new Error(`${source.name} returned an access challenge or invalid HTML`);
      }
      return html;
    }
    throw new Error(`${source.name} exceeded its redirect/retry limit`);
  };
}

function validateListing(listing: NormalizedListing, source: ListingSourceAdapter, transactionType: ListingTransactionType): void {
  assertListingSourceUrl(listing.url, source);
  if (listing.source !== source.key || listing.transactionType !== transactionType || !listing.sourceListingId || !listing.title.trim()) {
    throw new Error("Listing identity or transaction type does not match its source");
  }
  const numbers = [listing.price, listing.areaM2, listing.landAreaM2, listing.rooms];
  if (numbers.some((value) => value !== null && (!Number.isFinite(value) || value < 0))) {
    throw new Error("Listing contains invalid price or area data");
  }
  const { latitude, longitude } = listing;
  if ((latitude === null) !== (longitude === null) || (latitude !== null && (!Number.isFinite(latitude) || Math.abs(latitude) > 90)) || (longitude !== null && (!Number.isFinite(longitude) || Math.abs(longitude) > 180))) {
    throw new Error("Listing coordinates are invalid");
  }
}

async function saveListings(client: PoolClient, listings: NormalizedListing[], source: ListingSourceKey, transactionType: ListingTransactionType, complete: boolean): Promise<number> {
  await client.query("BEGIN");
  try {
    for (const listing of listings) {
      await client.query(`
        INSERT INTO public.property_listings (
          id, source, source_listing_id, url, transaction_type, property_type,
          title, description, location_text, address, price, currency, price_unit,
          area_m2, land_area_m2, rooms, latitude, longitude, location_accuracy, images,
          first_seen_at, last_seen_at, updated_at, active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
        ON CONFLICT (id) DO UPDATE SET
          url = EXCLUDED.url, property_type = EXCLUDED.property_type,
          title = EXCLUDED.title, description = EXCLUDED.description,
          location_text = EXCLUDED.location_text, address = EXCLUDED.address,
          price = EXCLUDED.price, currency = EXCLUDED.currency, price_unit = EXCLUDED.price_unit,
          area_m2 = EXCLUDED.area_m2, land_area_m2 = EXCLUDED.land_area_m2, rooms = EXCLUDED.rooms,
          latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          location_accuracy = EXCLUDED.location_accuracy, images = EXCLUDED.images,
          last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, active = true
      `, [
        `${listing.source}:${listing.transactionType}:${listing.sourceListingId}`,
        listing.source, listing.sourceListingId, listing.url, listing.transactionType,
        listing.propertyType, listing.title, listing.description, listing.locationText,
        listing.address, listing.price, listing.currency, listing.priceUnit, listing.areaM2,
        listing.landAreaM2, listing.rooms, listing.latitude, listing.longitude,
        listing.locationAccuracy, JSON.stringify(listing.images),
      ]);
    }
    let deactivated = 0;
    if (complete) {
      const result = await client.query(`
        UPDATE public.property_listings SET active = false, updated_at = CURRENT_TIMESTAMP
        WHERE source = $1 AND transaction_type = $2 AND active = true
          AND NOT (id = ANY($3::text[]))
      `, [source, transactionType, listings.map((listing) => `${source}:${transactionType}:${listing.sourceListingId}`)]);
      deactivated = result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return deactivated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function ingestListings(database: Pool, options: ListingIngestOptions = {}, dependencies: ListingIngestDependencies = {}): Promise<ListingIngestResult> {
  const settings = validateListingIngestOptions(options);
  const adapters = dependencies.adapters ?? listingAdapters;
  for (const key of settings.sources) {
    if (!adapters[key]) throw new ApiValidationError(`${key} is not currently available; see /listings/sources`);
  }
  const fetchHtml = dependencies.fetchHtml ?? createListingFetcher();
  const summaries: ListingImportSummary[] = [];
  const client = await database.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["property-listings-ingest"]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw Object.assign(new Error("A listing import is already running"), { statusCode: 409 });
    for (const sourceKey of settings.sources) {
      const source = adapters[sourceKey]!;
      for (const transactionType of settings.transactionTypes) {
        const summary: ListingImportSummary = { source: sourceKey, transactionType, status: "success", pages: 0, saved: 0, skipped: 0, located: 0, complete: false, deactivated: 0 };
        try {
          let url: string | null = source.searchUrl(transactionType);
          const visitedPages = new Set<string>();
          const visitedListings = new Set<string>();
          const found = new Map<string, NormalizedListing>();
          let capped = false;
          while (url !== null && summary.pages < settings.maxPages) {
            assertListingSourceUrl(url, source);
            if (visitedPages.has(url)) throw new Error("Source pagination repeated a page");
            visitedPages.add(url);
            const page = source.parseSearchPage(await fetchHtml(url, source), url);
            summary.pages++;
            for (const listingUrl of page.listingUrls) {
              if (visitedListings.has(listingUrl)) continue;
              if (visitedListings.size >= settings.maxListings) { capped = true; break; }
              assertListingSourceUrl(listingUrl, source);
              visitedListings.add(listingUrl);
              const listing = source.parseListing(await fetchHtml(listingUrl, source), listingUrl, transactionType);
              if (!listing) { summary.skipped++; continue; }
              validateListing(listing, source, transactionType);
              found.set(listing.sourceListingId, listing);
            }
            url = page.nextPageUrl;
            if (capped) break;
          }
          // Skipped ads can include foreign properties and wanted ads. Keep old
          // data whenever coverage is ambiguous rather than retire unseen ads.
          summary.complete = url === null && !capped && summary.skipped === 0 && found.size > 0;
          const listings = [...found.values()];
          summary.deactivated = await saveListings(client, listings, sourceKey, transactionType, summary.complete);
          summary.saved = listings.length;
          summary.located = listings.filter((listing) => listing.latitude !== null).length;
        } catch (error) {
          summary.status = "failed";
          summary.complete = false;
          summary.error = error instanceof Error ? error.message : String(error);
        }
        summaries.push(summary);
        dependencies.onProgress?.(summary);
      }
    }
    return { retrievedAt: new Date().toISOString(), summaries };
  } finally {
    let releaseError: Error | undefined;
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["property-listings-ingest"]);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
}
