import { setTimeout as delay } from "node:timers/promises";
import axios from "axios";
import type { Pool, PoolClient } from "pg";

import { ApiValidationError } from "../gurs/query.js";
import { listingFingerprint } from "./fingerprint.js";
import { isListingImportStopped, ListingImportStopped, throwIfListingImportStopped } from "./stop.js";
import { listingAdapters, listingSources, listingSourcesFor, splitSourceList } from "./sources/index.js";
import type {
  ListingCatalogueLimits,
  ListingFetchHtml,
  ListingHttpRequest,
  ListingSourceAdapter,
  ListingSourceKey,
  ListingTransactionType,
  NormalizedListing,
} from "./types.js";

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
  crossSourceDuplicates: number;
  error?: string;
};
export type ListingIngestResult = {
  retrievedAt: string;
  summaries: ListingImportSummary[];
};
export type ListingPreview = ListingIngestResult & {
  dryRun: true;
  listings: NormalizedListing[];
};
export type ListingIngestDependencies = {
  adapters?: Partial<Record<ListingSourceKey, ListingSourceAdapter>>;
  fetchHtml?: ListingFetchHtml;
  onProgress?: (summary: ListingImportSummary) => void;
  env?: NodeJS.ProcessEnv;
};

function sourcePriority(key: string): number {
  return listingSources.find((source) => source.key === key)?.priority ?? 99;
}

export function validateListingIngestOptions(options: ListingIngestOptions = {}, env: NodeJS.ProcessEnv = process.env): Required<ListingIngestOptions> {
  const unknown = Object.keys(options).filter((name) => !["sources", "transactionTypes", "maxPages", "maxListings"].includes(name));
  if (unknown.length) throw new ApiValidationError(`Unknown import option: ${unknown.join(", ")}`);
  const configured = splitSourceList(env.LISTING_SOURCES);
  const unknownConfigured = configured.filter((key) => !listingSources.some((source) => source.key === key));
  if (!options.sources && unknownConfigured.length) throw new ApiValidationError(`Unknown listing source in LISTING_SOURCES: ${unknownConfigured.join(", ")}`);
  if (!options.sources && new Set(configured).size !== configured.length) throw new ApiValidationError("LISTING_SOURCES contains duplicates");
  const sources = options.sources ?? listingSourcesFor(env).filter((source) => source.enabled).map((source) => source.key);
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

function requestOf(request: string | ListingHttpRequest): ListingHttpRequest {
  return typeof request === "string" ? { url: request } : request;
}

// One request at a time, with a delay and bounded retries. Challenges are errors,
// never empty catalogues, so they cannot cause existing ads to be retired.
export function createListingFetcher(
  wait: (milliseconds: number) => Promise<unknown> = delay,
  options?: { signal?: AbortSignal },
): ListingFetchHtml {
  const signal = options?.signal;
  const pauseFor = async (milliseconds: number) => {
    throwIfListingImportStopped(signal);
    if (!signal) {
      await wait(milliseconds);
      return;
    }
    if (wait === delay) {
      try {
        await delay(milliseconds, undefined, { signal });
      } catch (error) {
        if (signal.aborted || isListingImportStopped(error)) throw new ListingImportStopped();
        throw error;
      }
      return;
    }
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        wait(milliseconds),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new ListingImportStopped());
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
    throwIfListingImportStopped(signal);
  };
  return async (original, source) => {
    const requested = requestOf(original);
    let url = requested.url;
    let method = requested.method ?? "GET";
    let body = requested.body;
    const pause = source.minDelayMs ?? 1500;
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfListingImportStopped(signal);
      assertListingSourceUrl(url, source);
      await pauseFor(pause);
      let response;
      try {
        const requestOptions = {
          timeout: 30_000,
          responseType: "text" as const,
          maxContentLength: 10 * 1024 * 1024,
          maxRedirects: 0,
          validateStatus: () => true,
          headers: {
            "User-Agent": "PropertyScraper/0.1 (+listing catalogue import)",
            Accept: requested.accept ?? "text/html,application/json,application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
            ...(requested.contentType ? { "Content-Type": requested.contentType } : {}),
          },
          ...(signal ? { signal } : {}),
        };
        response = method === "POST"
          ? await axios.post<string>(url, body, requestOptions)
          : await axios.get<string>(url, requestOptions);
      } catch (error) {
        if (signal?.aborted || isListingImportStopped(error)) throw new ListingImportStopped();
        if (attempt === 2) throw error;
        throwIfListingImportStopped(signal);
        await wait(1000 * 2 ** attempt);
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (typeof location !== "string") throw new Error(`Invalid redirect from ${source.name}`);
        url = new URL(location, url).href;
        assertListingSourceUrl(url, source);
        if ([301, 302, 303].includes(response.status)) { method = "GET"; body = undefined; }
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
      const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
      if (!html.trim() || /cf-chl-|<title>\s*(?:just a moment|attention required)|captcha-delivery/i.test(html)) {
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

async function linkFingerprints(client: PoolClient, transactionType: ListingTransactionType, listings: NormalizedListing[]): Promise<number> {
  const fingerprints = [...new Set(listings.map(listingFingerprint).filter((value): value is string => value !== null))];
  if (fingerprints.length === 0) return 0;
  const existing = await client.query<{ id: string; source: string; content_fingerprint: string; last_seen_at: string | Date }>(`
    SELECT id, source, content_fingerprint, last_seen_at
    FROM public.property_listings
    WHERE transaction_type = $1 AND content_fingerprint = ANY($2::text[])
  `, [transactionType, fingerprints]);
  const groups = new Map<string, typeof existing.rows>();
  for (const row of existing.rows) {
    const group = groups.get(row.content_fingerprint) ?? [];
    group.push(row);
    groups.set(row.content_fingerprint, group);
  }
  const ids: string[] = [];
  const duplicateOf: Array<string | null> = [];
  const batchIds = new Set(listings.map((listing) => `${listing.source}:${listing.transactionType}:${listing.sourceListingId}`));
  let crossSourceDuplicates = 0;
  for (const group of groups.values()) {
    const ranked = [...group].sort((left, right) => sourcePriority(left.source) - sourcePriority(right.source)
      || new Date(right.last_seen_at).getTime() - new Date(left.last_seen_at).getTime()
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const winner = ranked[0];
    if (!winner) continue;
    if (new Set(group.map((row) => row.source)).size > 1) {
      crossSourceDuplicates += group.filter((row) => batchIds.has(row.id)).length;
    }
    for (const row of ranked) {
      ids.push(row.id);
      duplicateOf.push(row.id === winner.id ? null : winner.id);
    }
  }
  if (ids.length) {
    await client.query(`
      UPDATE public.property_listings AS listing
      SET duplicate_of = data.duplicate_of, updated_at = CURRENT_TIMESTAMP
      FROM (SELECT unnest($1::text[]) AS id, unnest($2::text[]) AS duplicate_of) AS data
      WHERE listing.id = data.id AND listing.duplicate_of IS DISTINCT FROM data.duplicate_of
    `, [ids, duplicateOf]);
  }
  return crossSourceDuplicates;
}

export async function saveListings(client: PoolClient, listings: NormalizedListing[], source: ListingSourceKey, transactionType: ListingTransactionType, complete: boolean): Promise<{ deactivated: number; crossSourceDuplicates: number; inserted: number; updated: number }> {
  await client.query("BEGIN");
  try {
    let inserted = 0;
    let updated = 0;
    for (const listing of listings) {
      const saved = await client.query<{ inserted: boolean }>(`
        INSERT INTO public.property_listings (
          id, source, source_listing_id, url, transaction_type, property_type,
          title, description, location_text, address, price, currency, price_unit,
          area_m2, land_area_m2, rooms, latitude, longitude, location_accuracy, images,
          content_fingerprint, first_seen_at, last_seen_at, scraped_at, updated_at, active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
        ON CONFLICT (id) DO UPDATE SET
          url = EXCLUDED.url, property_type = EXCLUDED.property_type,
          title = EXCLUDED.title, description = EXCLUDED.description,
          location_text = EXCLUDED.location_text, address = EXCLUDED.address,
          price = EXCLUDED.price, currency = EXCLUDED.currency, price_unit = EXCLUDED.price_unit,
          area_m2 = EXCLUDED.area_m2, land_area_m2 = EXCLUDED.land_area_m2, rooms = EXCLUDED.rooms,
          latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          location_accuracy = EXCLUDED.location_accuracy, images = EXCLUDED.images,
          content_fingerprint = EXCLUDED.content_fingerprint,
          duplicate_of = CASE WHEN EXCLUDED.content_fingerprint IS NULL THEN NULL ELSE public.property_listings.duplicate_of END,
          last_seen_at = CURRENT_TIMESTAMP, scraped_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, active = true
        RETURNING (first_seen_at = updated_at) AS inserted
      `, [
        `${listing.source}:${listing.transactionType}:${listing.sourceListingId}`,
        listing.source, listing.sourceListingId, listing.url, listing.transactionType,
        listing.propertyType, listing.title, listing.description, listing.locationText,
        listing.address, listing.price, listing.currency, listing.priceUnit, listing.areaM2,
        listing.landAreaM2, listing.rooms, listing.latitude, listing.longitude,
        listing.locationAccuracy, JSON.stringify(listing.images), listingFingerprint(listing),
      ]);
      if (saved.rows[0]?.inserted === true) inserted += 1;
      else if (saved.rows[0]?.inserted === false) updated += 1;
    }
    const crossSourceDuplicates = await linkFingerprints(client, transactionType, listings);
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
    return { deactivated, crossSourceDuplicates, inserted, updated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export type ListingWalkResult = {
  summary: ListingImportSummary;
  listings: NormalizedListing[];
  fetched: number;
  outsideLookback: number;
  reachedLookback: boolean;
  lookbackApplied: boolean;
  exhausted: boolean;
  capped: boolean;
};

function catalogueReadLimits(source: ListingSourceAdapter, transactionType: ListingTransactionType, limits: ListingCatalogueLimits): ListingCatalogueLimits {
  const readLimits: ListingCatalogueLimits = { maxPages: limits.maxPages, maxListings: limits.maxListings };
  if (limits.publishedAfter) readLimits.publishedAfter = limits.publishedAfter;
  if (limits.signal) readLimits.signal = limits.signal;
  if (limits.onBatch) {
    const onBatch = limits.onBatch;
    readLimits.onBatch = async (batch) => {
      for (const listing of batch.listings) validateListing(listing, source, transactionType);
      await onBatch(batch);
    };
  }
  return readLimits;
}

export async function collectListingCatalogue(
  source: ListingSourceAdapter,
  transactionType: ListingTransactionType,
  limits: ListingCatalogueLimits,
  fetchHtml: ListingFetchHtml,
): Promise<ListingWalkResult> {
  const summary: ListingImportSummary = {
    source: source.key, transactionType, status: "success", pages: 0, saved: 0, skipped: 0,
    located: 0, complete: false, deactivated: 0, crossSourceDuplicates: 0,
  };
  const found = new Map<string, NormalizedListing>();
  let fetched = 0;
  let outsideLookback = 0;
  let reachedLookback = false;
  let lookbackApplied = false;
  let exhausted = false;
  let capped = false;
  try {
    if (source.readCatalogue) {
      const catalogue = await source.readCatalogue(transactionType, catalogueReadLimits(source, transactionType, limits), fetchHtml);
      summary.pages = catalogue.pages;
      summary.skipped = catalogue.skipped;
      fetched = catalogue.fetched ?? catalogue.listings.length + catalogue.skipped;
      outsideLookback = catalogue.outsideLookback ?? 0;
      reachedLookback = catalogue.reachedLookback === true;
      lookbackApplied = catalogue.lookbackApplied === true;
      exhausted = catalogue.exhausted === true;
      capped = catalogue.capped === true;
      for (const listing of catalogue.listings) {
        validateListing(listing, source, transactionType);
        found.set(listing.sourceListingId, listing);
      }
      summary.complete = catalogue.complete && summary.skipped === 0 && found.size > 0;
      if (limits.publishedAfter || reachedLookback) summary.complete = false;
    } else {
      let url: string | null = source.searchUrl(transactionType);
      const visitedPages = new Set<string>();
      const visitedListings = new Set<string>();
      while (url !== null && summary.pages < limits.maxPages && !reachedLookback) {
        throwIfListingImportStopped(limits.signal);
        assertListingSourceUrl(url, source);
        if (visitedPages.has(url)) throw new Error("Source pagination repeated a page");
        visitedPages.add(url);
        const page = source.parseSearchPage(await fetchHtml(url, source), url);
        summary.pages += 1;
        const pageListings: NormalizedListing[] = [];
        let pageOlder = false;
        for (const listingUrl of page.listingUrls) {
          if (visitedListings.has(listingUrl)) continue;
          if (visitedListings.size >= limits.maxListings) { capped = true; break; }
          const published = page.publishedAt?.[listingUrl];
          if (published) lookbackApplied = true;
          if (published && limits.publishedAfter && Date.parse(published) < limits.publishedAfter.getTime()) {
            visitedListings.add(listingUrl);
            fetched += 1;
            outsideLookback += 1;
            summary.skipped += 1;
            pageOlder = true;
            continue;
          }
          if (limits.signal?.aborted) {
            if (limits.onBatch && pageListings.length > 0) {
              await limits.onBatch({
                listings: pageListings, pages: summary.pages, skipped: summary.skipped, fetched,
                outsideLookback, reachedLookback, lookbackApplied, exhausted: false, capped,
              });
            }
            throw new ListingImportStopped();
          }
          assertListingSourceUrl(listingUrl, source);
          visitedListings.add(listingUrl);
          fetched += 1;
          let listing: NormalizedListing | null;
          try {
            listing = source.parseListing(await fetchHtml(listingUrl, source), listingUrl, transactionType);
          } catch (error) {
            if (!isListingImportStopped(error)) throw error;
            if (limits.onBatch && pageListings.length > 0) {
              await limits.onBatch({
                listings: pageListings, pages: summary.pages, skipped: summary.skipped, fetched,
                outsideLookback, reachedLookback, lookbackApplied, exhausted: false, capped,
              });
            }
            throw error;
          }
          if (!listing) { summary.skipped += 1; continue; }
          validateListing(listing, source, transactionType);
          if (!found.has(listing.sourceListingId)) pageListings.push(listing);
          found.set(listing.sourceListingId, listing);
        }
        if (pageOlder) reachedLookback = true;
        if (summary.pages >= limits.maxPages && page.nextPageUrl !== null && !reachedLookback) capped = true;
        if (limits.onBatch) {
          await limits.onBatch({
            listings: pageListings, pages: summary.pages, skipped: summary.skipped, fetched, outsideLookback,
            reachedLookback, lookbackApplied, exhausted: page.nextPageUrl === null && !capped && !reachedLookback, capped,
          });
        }
        url = page.nextPageUrl;
        if (capped || reachedLookback) break;
      }
      if (summary.pages >= limits.maxPages && url !== null && !reachedLookback) capped = true;
      exhausted = url === null && !capped && !reachedLookback;
      // Skipped ads can include foreign properties and wanted ads. Keep old
      // data whenever coverage is ambiguous rather than retire unseen ads.
      // A lookback window is also a partial catalogue: never report it complete.
      summary.complete = url === null && !capped && summary.skipped === 0 && found.size > 0;
      if (limits.publishedAfter || reachedLookback) summary.complete = false;
    }
    const listings = [...found.values()];
    summary.saved = listings.length;
    summary.located = listings.filter((listing) => listing.latitude !== null).length;
    return { summary, listings, fetched, outsideLookback, reachedLookback, lookbackApplied, exhausted, capped };
  } catch (error) {
    if (isListingImportStopped(error)) throw error instanceof ListingImportStopped ? error : new ListingImportStopped();
    summary.status = "failed";
    summary.complete = false;
    summary.saved = 0;
    summary.error = error instanceof Error ? error.message : String(error);
    return { summary, listings: [], fetched, outsideLookback, reachedLookback, lookbackApplied, exhausted, capped };
  }
}

export async function previewListings(options: ListingIngestOptions = {}, dependencies: ListingIngestDependencies = {}): Promise<ListingPreview> {
  const settings = validateListingIngestOptions(options, dependencies.env);
  const adapters = dependencies.adapters ?? listingAdapters;
  for (const key of settings.sources) {
    if (!adapters[key]) throw new ApiValidationError(`${key} is not currently available; see /listings/sources`);
  }
  const fetchHtml = dependencies.fetchHtml ?? createListingFetcher();
  const summaries: ListingImportSummary[] = [];
  const listings: NormalizedListing[] = [];
  for (const sourceKey of settings.sources) {
    const source = adapters[sourceKey]!;
    for (const transactionType of settings.transactionTypes) {
      const collected = await collectListingCatalogue(source, transactionType, settings, fetchHtml);
      summaries.push(collected.summary);
      listings.push(...collected.listings);
      dependencies.onProgress?.(collected.summary);
    }
  }
  return { dryRun: true, retrievedAt: new Date().toISOString(), summaries, listings };
}

export async function ingestListings(database: Pool, options: ListingIngestOptions = {}, dependencies: ListingIngestDependencies = {}): Promise<ListingIngestResult> {
  const settings = validateListingIngestOptions(options, dependencies.env);
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
        const collected = await collectListingCatalogue(source, transactionType, settings, fetchHtml);
        if (collected.summary.status === "success") {
          try {
            const saved = await saveListings(client, collected.listings, sourceKey, transactionType, collected.summary.complete);
            collected.summary.deactivated = saved.deactivated;
            collected.summary.crossSourceDuplicates = saved.crossSourceDuplicates;
          } catch (error) {
            collected.summary.status = "failed";
            collected.summary.complete = false;
            collected.summary.saved = 0;
            collected.summary.error = error instanceof Error ? error.message : String(error);
          }
        }
        summaries.push(collected.summary);
        dependencies.onProgress?.(collected.summary);
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
